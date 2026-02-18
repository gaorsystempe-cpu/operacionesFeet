
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { 
  TrendingUp, RefreshCw, AlertCircle, FileSpreadsheet, 
  LayoutGrid, ClipboardList, Store, MapPin, Loader2, ArrowDownToLine, Calculator, Target, Info, ShieldCheck, ReceiptText
} from 'lucide-react';
import { Venta, OdooSession } from '../types';
import { OdooClient } from '../services/odoo';
import * as XLSX from 'xlsx';

interface DashboardProps {
    session: OdooSession | null;
    view?: string;
}

type FilterMode = 'hoy' | 'mes' | 'anio' | 'custom';
type ReportTab = 'consolidado' | 'recepcion' | 'surco';

const Dashboard: React.FC<DashboardProps> = ({ session }) => {
  const [ventasData, setVentasData] = useState<Venta[]>([]); 
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>('mes');
  const [activeTab, setActiveTab] = useState<ReportTab>('consolidado');
  const [syncProgress, setSyncProgress] = useState('');
  
  const getInitialDates = () => {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), 1).toLocaleDateString('en-CA');
    const end = today.toLocaleDateString('en-CA');
    return { start, end };
  };

  const [dateRange, setDateRange] = useState(getInitialDates());

  const updateRangeByMode = (mode: FilterMode) => {
    setFilterMode(mode);
    const today = new Date();
    let start = '';
    let end = today.toLocaleDateString('en-CA');

    if (mode === 'hoy') {
        start = end;
    } else if (mode === 'mes') {
        start = new Date(today.getFullYear(), today.getMonth(), 1).toLocaleDateString('en-CA');
    } else if (mode === 'anio') {
        start = new Date(today.getFullYear(), 0, 1).toLocaleDateString('en-CA');
    }
    
    if (mode !== 'custom') {
        setDateRange({ start, end });
    }
  };

  const fetchData = useCallback(async () => {
      if (!session) return;
      setLoading(true);
      setError(null);
      setSyncProgress('Autenticando...');

      try {
          const client = new OdooClient(session.url, session.db);
          
          setSyncProgress('Buscando Ventas...');
          const domain: any[] = [
            ['state', 'in', ['paid', 'done', 'invoiced']], 
            ['date_order', '>=', `${dateRange.start} 00:00:00`],
            ['date_order', '<=', `${dateRange.end} 23:59:59`]
          ];
          if (session.companyId) domain.push(['company_id', '=', session.companyId]);

          const orders = await client.searchRead(session.uid, session.apiKey, 'pos.order', domain, 
            ['date_order', 'config_id', 'lines', 'amount_total', 'user_id'], 
            { order: 'date_order desc', limit: 3000 }
          );

          if (!orders || orders.length === 0) {
              setVentasData([]);
              setSyncProgress('Sin ventas');
              setLoading(false);
              return;
          }

          setSyncProgress('Cargando Líneas...');
          const allLineIds = orders.flatMap((o: any) => o.lines || []);
          const linesData = await client.searchRead(session.uid, session.apiKey, 'pos.order.line', [['id', 'in', allLineIds]], 
                ['product_id', 'qty', 'price_subtotal', 'price_subtotal_incl', 'order_id']);

          setSyncProgress('Sincronizando Costos...');
          const productIds = Array.from(new Set(linesData.map((l: any) => l.product_id[0])));
          
          const products = await client.searchRead(
            session.uid, 
            session.apiKey, 
            'product.product', 
            [['id', 'in', productIds]], 
            ['standard_price', 'categ_id'],
            { context: { company_id: session.companyId } }
          );
          
          const productMap = new Map<number, { cost: number; cat: string }>(
            products.map((p: any) => [
              p.id, 
              { cost: p.standard_price || 0, cat: p.categ_id ? p.categ_id[1] : 'Insumo' }
            ])
          );
          
          const linesByOrder = new Map();
          linesData.forEach((l: any) => {
              const oId = l.order_id[0];
              if (!linesByOrder.has(oId)) linesByOrder.set(oId, []);
              linesByOrder.get(oId).push(l);
          });

          setSyncProgress('Calculando IGV y Rentabilidad...');
          const mapped: Venta[] = orders.flatMap((o: any) => {
              const orderLines = linesByOrder.get(o.id) || [];
              const orderDate = new Date(o.date_order.replace(' ', 'T') + 'Z');
              const sede = o.config_id[1] || 'Caja Central';

              return orderLines.map((l: any) => {
                  const pId = l.product_id[0];
                  const pInfo = productMap.get(pId) || { cost: 0, cat: 'S/C' };
                  
                  const ventaNeta = l.price_subtotal || 0; 
                  const ventaTotal = l.price_subtotal_incl || 0;
                  const costoTotalLinea = pInfo.cost * l.qty;
                  
                  // Utilidad Neta: Sin considerar el IGV de la venta (Base Imponible - Costo)
                  const utilidadNeta = ventaNeta - costoTotalLinea;
                  // Utilidad Bruta: Dinero que entra a caja menos el costo (Total - Costo)
                  const utilidadBruta = ventaTotal - costoTotalLinea;

                  return {
                      fecha: orderDate,
                      sede,
                      compania: session.companyName || '',
                      vendedor: o.user_id[1] || 'Usuario',
                      producto: l.product_id[1],
                      categoria: pInfo.cat,
                      total: ventaTotal, 
                      subtotal: ventaNeta,
                      costo: costoTotalLinea,
                      margen: utilidadNeta,
                      margenBruto: utilidadBruta,
                      cantidad: l.qty,
                      sesion: '', 
                      metodoPago: '-',
                      margenPorcentaje: ventaNeta > 0 ? ((utilidadNeta / ventaNeta) * 100).toFixed(1) : '0.0'
                  };
              });
          });

          setVentasData(mapped);
          setSyncProgress('¡Datos cuadrados!');
      } catch (err: any) {
          setError(`Error: ${err.message}`);
      } finally {
          setLoading(false);
      }
  }, [session, dateRange]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const dataFeetCare = useMemo(() => ventasData.filter(v => 
    v.sede.toUpperCase().includes('FEETCARE') || 
    (v.sede.toUpperCase().includes('RECEPCION') && !v.sede.toUpperCase().includes('SURCO'))
  ), [ventasData]);

  const dataFeetSurco = useMemo(() => ventasData.filter(v => 
    v.sede.toUpperCase().includes('SURCO')
  ), [ventasData]);

  const getStats = (data: Venta[]) => {
      const vBruta = data.reduce((s, x) => s + x.total, 0);
      const vNeta = data.reduce((s, x) => s + x.subtotal, 0);
      const c = data.reduce((s, x) => s + x.costo, 0);
      const mNeta = data.reduce((s, x) => s + x.margen, 0);
      const mBruta = data.reduce((s, x) => s + x.margenBruto, 0);
      return { 
        vBruta, 
        vNeta, 
        costo: c, 
        mNeta, 
        mBruta, 
        rent: vNeta > 0 ? ((mNeta / vNeta) * 100).toFixed(1) : '0.0' 
      };
  };

  const statsFeetCare = useMemo(() => getStats(dataFeetCare), [dataFeetCare]);
  const statsSurco = useMemo(() => getStats(dataFeetSurco), [dataFeetSurco]);
  const statsTotal = useMemo(() => getStats(ventasData), [ventasData]);

  const currentStats = useMemo(() => {
    if (activeTab === 'recepcion') return statsFeetCare;
    if (activeTab === 'surco') return statsSurco;
    return statsTotal;
  }, [activeTab, statsFeetCare, statsSurco, statsTotal]);

  const exportExcel = () => {
    const wb = XLSX.utils.book_new();
    const summaryData = [
      ["LEMON BI - AUDITORÍA DE RENTABILIDAD (DIFERENCIACIÓN IGV)"],
      ["Periodo:", `${dateRange.start} al ${dateRange.end}`],
      [],
      ["SEDE", "VENTA SIN IGV (NETA)", "VENTA CON IGV (TOTAL)", "COSTO", "GANANCIA (SIN IGV)", "GANANCIA (CON IGV)", "RENT %"]
    ];

    const pushStat = (name: string, st: any) => [name, st.vNeta, st.vBruta, st.costo, st.mNeta, st.mBruta, st.rent + "%"];
    summaryData.push(
        pushStat("FEETCARE", statsFeetCare),
        pushStat("SURCO", statsSurco),
        [],
        pushStat("TOTAL GLOBAL", statsTotal)
    );

    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryData), "Auditoría General");
    
    const createSheet = (data: Venta[]) => {
      return XLSX.utils.json_to_sheet(data.map(v => ({
        'Fecha': v.fecha.toLocaleDateString('es-PE'),
        'Producto': v.producto,
        'Cant': v.cantidad,
        'Venta Sin IGV': v.subtotal,
        'Venta Con IGV': v.total,
        'Costo Total': v.costo,
        'Utilidad Neta (Audit)': v.margen,
        'Utilidad Bruta (Caja)': v.margenBruto,
        '% Rent': v.margenPorcentaje + '%'
      })));
    };

    if (dataFeetCare.length > 0) XLSX.utils.book_append_sheet(wb, createSheet(dataFeetCare), "Detalle FeetCare");
    if (dataFeetSurco.length > 0) XLSX.utils.book_append_sheet(wb, createSheet(dataFeetSurco), "Detalle Surco");

    XLSX.writeFile(wb, `Reporte_Rentabilidad_Dual_${dateRange.start}.xlsx`);
  };

  const ReportSection = ({ data, title, totals }: { data: Venta[], title: string, totals: any }) => (
    <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-xl overflow-hidden mb-12 animate-in slide-in-from-bottom-6">
      <div className="px-10 py-8 bg-slate-50 border-b border-slate-100 flex justify-between items-center">
        <div>
           <h3 className="text-xl font-black text-slate-900 uppercase tracking-tighter flex items-center gap-3">
             <ReceiptText className="text-brand-500 w-6 h-6" /> {title}
           </h3>
           <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mt-1 italic">Diferenciación de Base Imponible vs Montos Cobrados</p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="bg-slate-50/50 text-[9px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
            <tr>
              <th className="px-8 py-6">Producto</th>
              <th className="px-8 py-6 text-right">Venta (Sin IGV)</th>
              <th className="px-8 py-6 text-right">Venta (Con IGV)</th>
              <th className="px-8 py-6 text-right">Costo</th>
              <th className="px-8 py-6 text-right">Utilidad (Sin IGV)</th>
              <th className="px-8 py-6 text-right">Utilidad (Con IGV)</th>
              <th className="px-8 py-6 text-center">Rent %</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.map((v, i) => (
              <tr key={i} className="hover:bg-slate-50 transition-all group">
                <td className="px-8 py-5">
                   <p className="font-black text-slate-900 text-[11px] uppercase leading-tight">{v.producto}</p>
                   <p className="text-[8px] text-slate-400 font-bold mt-1 uppercase">{v.fecha.toLocaleDateString('es-PE')}</p>
                </td>
                <td className="px-8 py-5 text-right font-bold text-slate-400 text-xs italic">S/ {v.subtotal.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</td>
                <td className="px-8 py-5 text-right font-black text-slate-900 text-xs">S/ {v.total.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</td>
                <td className="px-8 py-5 text-right font-bold text-slate-300 text-xs italic">S/ {v.costo.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</td>
                <td className="px-8 py-5 text-right font-black text-brand-600 text-xs bg-brand-50/20">S/ {v.margen.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</td>
                <td className="px-8 py-5 text-right font-black text-blue-600 text-xs">S/ {v.margenBruto.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</td>
                <td className="px-8 py-5 text-center">
                   <span className="text-[10px] font-black text-brand-700 bg-brand-50 px-2 py-1 rounded-lg">{v.margenPorcentaje}%</span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-900 text-white font-black text-[11px]">
             <tr>
                <td className="px-8 py-6 text-right text-slate-500 uppercase">Totales:</td>
                <td className="px-8 py-6 text-right text-slate-400 italic">S/ {totals.vNeta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</td>
                <td className="px-8 py-6 text-right text-white text-sm tracking-tighter">S/ {totals.vBruta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</td>
                <td className="px-8 py-6 text-right text-slate-500">S/ {totals.costo.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</td>
                <td className="px-8 py-6 text-right text-brand-400 text-sm">S/ {totals.mNeta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</td>
                <td className="px-8 py-6 text-right text-blue-400 text-sm">S/ {totals.mBruta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</td>
                <td className="px-8 py-6 text-center text-brand-500">{totals.rent}%</td>
             </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );

  return (
    <div className="p-4 md:p-10 font-sans max-w-7xl mx-auto space-y-8 animate-in fade-in pb-24">
      
      {/* HEADER */}
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-end gap-6 border-b border-slate-200 pb-10">
        <div className="space-y-2">
           <div className="flex items-center gap-4">
             <div className="p-4 bg-brand-500 rounded-[1.5rem] shadow-xl shadow-brand-500/30"><TrendingUp className="text-white w-7 h-7" /></div>
             <h1 className="text-4xl font-black text-slate-900 tracking-tighter uppercase italic leading-none">Reconciliación Contable</h1>
           </div>
           <p className="text-slate-500 text-sm font-medium ml-1">
             Ganancia auditada comparando montos Netos vs Totales.
             {loading && <span className="ml-4 text-brand-600 font-black text-[10px] uppercase animate-pulse flex items-center gap-2 inline-flex"><Loader2 className="w-3 h-3 animate-spin"/> {syncProgress}</span>}
           </p>
        </div>
        <div className="flex gap-4 w-full lg:w-auto">
           <button onClick={fetchData} disabled={loading} className="flex-1 lg:flex-none flex items-center justify-center gap-3 bg-white px-8 py-4 rounded-2xl border border-slate-200 font-black text-[11px] hover:bg-slate-50 transition-all uppercase tracking-widest shadow-sm">
             <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-brand-500' : ''}`} /> Sincronizar Odoo
           </button>
           <button onClick={exportExcel} className="flex-1 lg:flex-none flex items-center justify-center gap-3 bg-slate-900 text-white px-8 py-4 rounded-2xl font-black text-[11px] shadow-2xl hover:bg-slate-800 transition-all uppercase tracking-widest">
             <FileSpreadsheet className="w-4 h-4" /> Exportar Auditoría
           </button>
        </div>
      </div>

      {/* SELECTOR DE SEDE */}
      <div className="bg-slate-100 p-2 rounded-[3rem] border border-slate-200 flex flex-wrap gap-2 w-full lg:w-fit shadow-inner">
         <button onClick={() => setActiveTab('consolidado')} className={`flex-1 lg:flex-none flex items-center justify-center gap-3 px-10 py-5 rounded-[2.5rem] font-black text-[11px] uppercase tracking-widest transition-all ${activeTab === 'consolidado' ? 'bg-slate-900 text-white shadow-2xl scale-[1.02]' : 'text-slate-400 hover:bg-slate-200'}`}>
            <LayoutGrid className="w-4 h-4" /> Global
         </button>
         <button onClick={() => setActiveTab('recepcion')} className={`flex-1 lg:flex-none flex items-center justify-center gap-3 px-10 py-5 rounded-[2.5rem] font-black text-[11px] uppercase tracking-widest transition-all ${activeTab === 'recepcion' ? 'bg-brand-500 text-white shadow-2xl scale-[1.02]' : 'text-slate-400 hover:bg-slate-200'}`}>
            <Store className="w-4 h-4" /> FeetCare
         </button>
         <button onClick={() => setActiveTab('surco')} className={`flex-1 lg:flex-none flex items-center justify-center gap-3 px-10 py-5 rounded-[2.5rem] font-black text-[11px] uppercase tracking-widest transition-all ${activeTab === 'surco' ? 'bg-blue-600 text-white shadow-2xl scale-[1.02]' : 'text-slate-400 hover:bg-slate-200'}`}>
            <MapPin className="w-4 h-4" /> Surco
         </button>
      </div>

      {/* KPIs CON DESGLOSE IGV */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm relative overflow-hidden">
             <div className="relative z-10">
                <p className="text-slate-400 text-[9px] font-black uppercase tracking-widest mb-1 flex items-center gap-2"><ArrowDownToLine className="w-3 h-3"/> Venta Mensual</p>
                <h3 className="text-3xl font-black text-slate-900 tracking-tighter">S/ {currentStats.vBruta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</h3>
                <p className="text-[9px] font-bold text-slate-400 mt-2 italic">Sin IGV: S/ {currentStats.vNeta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</p>
             </div>
             <Target className="absolute -bottom-4 -right-4 w-24 h-24 text-slate-50 opacity-50" />
          </div>
          <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm relative">
             <p className="text-slate-400 text-[9px] font-black uppercase tracking-widest mb-1 flex items-center gap-2"><Calculator className="w-3 h-3"/> Inversión (Costo)</p>
             <h3 className="text-3xl font-black text-slate-400 tracking-tighter">S/ {currentStats.costo.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</h3>
             <div className="mt-2 h-1 bg-slate-50 rounded-full overflow-hidden"><div className="bg-slate-200 h-full" style={{width: `${(currentStats.costo / currentStats.vNeta) * 100}%`}}></div></div>
          </div>
          <div className="bg-slate-900 p-8 rounded-[2.5rem] shadow-xl text-white">
             <div className="flex justify-between items-start mb-4">
                <p className="text-slate-500 text-[9px] font-black uppercase tracking-widest">Utilidad Neta (Auditada)</p>
                <ShieldCheck className="w-4 h-4 text-brand-500" />
             </div>
             <h3 className="text-3xl font-black tracking-tighter text-white">S/ {currentStats.mNeta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</h3>
             <p className="text-[9px] text-brand-400 font-black mt-2 uppercase tracking-widest">Rentabilidad Real: {currentStats.rent}%</p>
          </div>
          <div className="bg-brand-500 p-8 rounded-[2.5rem] shadow-xl shadow-brand-500/20 text-white">
             <p className="text-white/70 text-[9px] font-black uppercase tracking-widest mb-1">Margen de Caja (Con IGV)</p>
             <h3 className="text-3xl font-black tracking-tighter">S/ {currentStats.mBruta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</h3>
             <p className="text-[9px] font-medium mt-2 opacity-80 leading-tight">Monto total disponible tras deducir costos de Odoo.</p>
          </div>
      </div>

      {/* REPORTES */}
      <div className="space-y-4">
         {activeTab === 'consolidado' ? (
           <>
              <ReportSection data={dataFeetCare} title="Reporte: Sede FeetCare" totals={statsFeetCare} />
              <ReportSection data={dataFeetSurco} title="Reporte: Sede Surco" totals={statsSurco} />
           </>
         ) : activeTab === 'recepcion' ? (
           <ReportSection data={dataFeetCare} title="Sede FeetCare" totals={statsFeetCare} />
         ) : (
           <ReportSection data={dataFeetSurco} title="Sede Surco" totals={statsSurco} />
         )}
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-100 p-8 rounded-[3rem] flex items-center gap-6 text-rose-600 animate-in slide-in-from-top-6 shadow-xl">
          <AlertCircle className="w-8 h-8" />
          <p className="font-medium text-sm">{error}</p>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
