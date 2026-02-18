
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { 
  TrendingUp, RefreshCw, AlertCircle, FileSpreadsheet, 
  LayoutGrid, ClipboardList, Store, MapPin, Loader2, ArrowDownToLine, Calculator, Target, Info, ShieldCheck, ReceiptText, Calendar, ChevronLeft, ChevronRight, Filter
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
  
  // Estados para selección específica de tiempo
  const today = new Date();
  const [selectedMonth, setSelectedMonth] = useState(today.getMonth());
  const [selectedYear, setSelectedYear] = useState(today.getFullYear());
  const [customRange, setCustomRange] = useState({
    start: new Date(today.getFullYear(), today.getMonth(), 1).toLocaleDateString('en-CA'),
    end: today.toLocaleDateString('en-CA')
  });

  // Cálculo de fechas finales para la consulta Odoo
  const dateRange = useMemo(() => {
    let start = '';
    let end = '';

    if (filterMode === 'hoy') {
      start = today.toLocaleDateString('en-CA');
      end = start;
    } else if (filterMode === 'mes') {
      start = new Date(selectedYear, selectedMonth, 1).toLocaleDateString('en-CA');
      end = new Date(selectedYear, selectedMonth + 1, 0).toLocaleDateString('en-CA');
    } else if (filterMode === 'anio') {
      start = `${selectedYear}-01-01`;
      end = `${selectedYear}-12-31`;
    } else {
      start = customRange.start;
      end = customRange.end;
    }
    return { start, end };
  }, [filterMode, selectedMonth, selectedYear, customRange]);

  const fetchData = useCallback(async () => {
      if (!session) return;
      setLoading(true);
      setError(null);
      setSyncProgress('Autenticando...');

      try {
          const client = new OdooClient(session.url, session.db);
          
          setSyncProgress(`Consultando ${dateRange.start} al ${dateRange.end}...`);
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
              setSyncProgress('Sin registros');
              setLoading(false);
              return;
          }

          setSyncProgress('Extrayendo ítems...');
          const allLineIds = orders.flatMap((o: any) => o.lines || []);
          const linesData = await client.searchRead(session.uid, session.apiKey, 'pos.order.line', [['id', 'in', allLineIds]], 
                ['product_id', 'qty', 'price_subtotal', 'price_subtotal_incl', 'order_id']);

          setSyncProgress('Sincronizando costos...');
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
                      margen: ventaNeta - costoTotalLinea,
                      margenBruto: ventaTotal - costoTotalLinea,
                      cantidad: l.qty,
                      sesion: '', 
                      metodoPago: '-',
                      margenPorcentaje: ventaNeta > 0 ? (((ventaNeta - costoTotalLinea) / ventaNeta) * 100).toFixed(1) : '0.0'
                  };
              });
          });

          setVentasData(mapped);
          setSyncProgress('¡Información al día!');
      } catch (err: any) {
          setError(`Error de sincronización: ${err.message}`);
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
        vBruta, vNeta, costo: c, mNeta, mBruta, 
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

  const meses = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

  const ReportSection = ({ data, title, totals }: { data: Venta[], title: string, totals: any }) => (
    <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-xl overflow-hidden mb-12 animate-in slide-in-from-bottom-6">
      <div className="px-10 py-8 bg-slate-50 border-b border-slate-100 flex justify-between items-center">
        <div>
           <h3 className="text-xl font-black text-slate-900 uppercase tracking-tighter flex items-center gap-3">
             <ReceiptText className="text-brand-500 w-6 h-6" /> {title}
           </h3>
           <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mt-1 italic">Ventas detalladas del periodo seleccionado</p>
        </div>
        <div className="text-right">
           <span className="text-[9px] font-black text-slate-400 uppercase block mb-1">Items Totales</span>
           <span className="text-xl font-black text-slate-900">{data.length}</span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="bg-slate-50/50 text-[9px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
            <tr>
              <th className="px-8 py-6">Producto / Servicio</th>
              <th className="px-8 py-6 text-right">Monto Sin IGV</th>
              <th className="px-8 py-6 text-right">Monto Con IGV</th>
              <th className="px-8 py-6 text-right">Costo Odoo</th>
              <th className="px-8 py-6 text-right">Utilidad</th>
              <th className="px-8 py-6 text-center">Rent %</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.map((v, i) => (
              <tr key={i} className="hover:bg-slate-50 transition-all group">
                <td className="px-8 py-5">
                   <p className="font-black text-slate-900 text-[11px] uppercase leading-tight">{v.producto}</p>
                   <p className="text-[8px] text-slate-400 font-bold mt-1 uppercase">{v.fecha.toLocaleString('es-PE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
                </td>
                <td className="px-8 py-5 text-right font-bold text-slate-400 text-xs italic">S/ {v.subtotal.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</td>
                <td className="px-8 py-5 text-right font-black text-slate-900 text-xs">S/ {v.total.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</td>
                <td className="px-8 py-5 text-right font-bold text-slate-300 text-xs italic">S/ {v.costo.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</td>
                <td className="px-8 py-5 text-right font-black text-brand-600 text-xs bg-brand-50/20">S/ {v.margen.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</td>
                <td className="px-8 py-5 text-center">
                   <span className="text-[10px] font-black text-brand-700 bg-brand-50 px-2 py-1 rounded-lg">{v.margenPorcentaje}%</span>
                </td>
              </tr>
            ))}
            {data.length === 0 && (
                <tr><td colSpan={6} className="px-8 py-32 text-center text-slate-300 font-black uppercase tracking-[0.3em] italic">No se encontraron ventas en este rango</td></tr>
            )}
          </tbody>
          {data.length > 0 && (
            <tfoot className="bg-slate-900 text-white font-black text-[11px]">
               <tr>
                  <td className="px-8 py-6 text-right text-slate-500 uppercase">Totales {title}:</td>
                  <td className="px-8 py-6 text-right text-slate-400 italic">S/ {totals.vNeta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</td>
                  <td className="px-8 py-6 text-right text-white text-sm tracking-tighter">S/ {totals.vBruta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</td>
                  <td className="px-8 py-6 text-right text-slate-500">S/ {totals.costo.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</td>
                  <td className="px-8 py-6 text-right text-brand-400 text-sm">S/ {totals.mNeta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</td>
                  <td className="px-8 py-6 text-center text-brand-500">{totals.rent}%</td>
               </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );

  return (
    <div className="p-4 md:p-10 font-sans max-w-7xl mx-auto space-y-8 animate-in fade-in pb-24">
      
      {/* HEADER PRINCIPAL */}
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-end gap-6 border-b border-slate-200 pb-10">
        <div className="space-y-2">
           <div className="flex items-center gap-4">
             <div className="p-4 bg-brand-500 rounded-[1.5rem] shadow-xl shadow-brand-500/30"><TrendingUp className="text-white w-7 h-7" /></div>
             <div>
                <h1 className="text-4xl font-black text-slate-900 tracking-tighter uppercase italic leading-none">Análisis de Resultados</h1>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-2">Periodo: {dateRange.start} al {dateRange.end}</p>
             </div>
           </div>
        </div>
        <div className="flex gap-4 w-full lg:w-auto">
           <button onClick={fetchData} disabled={loading} className="flex-1 lg:flex-none flex items-center justify-center gap-3 bg-white px-8 py-4 rounded-2xl border border-slate-200 font-black text-[11px] hover:bg-slate-50 transition-all uppercase tracking-widest shadow-sm">
             <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-brand-500' : ''}`} /> Sincronizar Odoo
           </button>
        </div>
      </div>

      {/* CENTRO DE COMANDO DE FILTROS - MEJORADO */}
      <div className="bg-white p-8 rounded-[3.5rem] shadow-xl border border-slate-100 space-y-8">
         <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="flex bg-slate-100 p-1.5 rounded-2xl border border-slate-200">
               {(['hoy', 'mes', 'anio', 'custom'] as FilterMode[]).map(m => (
                 <button key={m} onClick={() => setFilterMode(m)} className={`px-10 py-3 rounded-xl text-[10px] font-black uppercase transition-all ${filterMode === m ? 'bg-white text-brand-600 shadow-sm border border-brand-100 scale-105' : 'text-slate-400 hover:text-slate-600'}`}>
                    {m === 'hoy' ? 'Hoy' : m === 'mes' ? 'Mes' : m === 'anio' ? 'Año' : 'Personalizado'}
                 </button>
               ))}
            </div>

            <div className="flex items-center gap-4 bg-slate-50 px-6 py-4 rounded-3xl border border-slate-100">
               {filterMode === 'mes' && (
                  <div className="flex items-center gap-4 animate-in slide-in-from-right-4">
                     <button onClick={() => setSelectedMonth(prev => prev === 0 ? 11 : prev - 1)} className="p-2 hover:bg-white rounded-lg transition-colors text-slate-400"><ChevronLeft size={20}/></button>
                     <div className="flex flex-col items-center min-w-[120px]">
                        <span className="text-[10px] font-black text-slate-400 uppercase">Mes Seleccionado</span>
                        <span className="text-sm font-black text-slate-900 uppercase tracking-tight">{meses[selectedMonth]} {selectedYear}</span>
                     </div>
                     <button onClick={() => setSelectedMonth(prev => prev === 11 ? 0 : prev + 1)} className="p-2 hover:bg-white rounded-lg transition-colors text-slate-400"><ChevronRight size={20}/></button>
                  </div>
               )}

               {filterMode === 'anio' && (
                  <div className="flex items-center gap-6 animate-in slide-in-from-right-4">
                     <button onClick={() => setSelectedYear(y => y - 1)} className="p-2 hover:bg-white rounded-lg transition-colors text-slate-400"><ChevronLeft size={20}/></button>
                     <div className="flex flex-col items-center">
                        <span className="text-[10px] font-black text-slate-400 uppercase">Año Fiscal</span>
                        <span className="text-sm font-black text-slate-900">{selectedYear}</span>
                     </div>
                     <button onClick={() => setSelectedYear(y => y + 1)} className="p-2 hover:bg-white rounded-lg transition-colors text-slate-400"><ChevronRight size={20}/></button>
                  </div>
               )}

               {filterMode === 'custom' && (
                  <div className="flex items-center gap-4 animate-in slide-in-from-right-4">
                     <div className="flex flex-col gap-1">
                        <span className="text-[8px] font-black text-slate-400 uppercase ml-1">Desde</span>
                        <input type="date" value={customRange.start} onChange={e => setCustomRange({...customRange, start: e.target.value})} className="p-2 bg-white border border-slate-200 rounded-xl text-xs font-bold outline-none focus:ring-2 focus:ring-brand-500/20" />
                     </div>
                     <span className="text-slate-300 mt-4">→</span>
                     <div className="flex flex-col gap-1">
                        <span className="text-[8px] font-black text-slate-400 uppercase ml-1">Hasta</span>
                        <input type="date" value={customRange.end} onChange={e => setCustomRange({...customRange, end: e.target.value})} className="p-2 bg-white border border-slate-200 rounded-xl text-xs font-bold outline-none focus:ring-2 focus:ring-brand-500/20" />
                     </div>
                  </div>
               )}

               {filterMode === 'hoy' && (
                  <div className="flex items-center gap-3 px-4 py-1 text-emerald-600 animate-in fade-in">
                     <Calendar className="w-5 h-5" />
                     <span className="text-sm font-black uppercase tracking-tighter">{today.toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
                  </div>
               )}
            </div>
         </div>

         {/* SELECTOR DE SEDE INTERNO */}
         <div className="flex bg-slate-50 p-2 rounded-[2.5rem] border border-slate-100 gap-2 w-full lg:w-fit mx-auto shadow-inner">
            <button onClick={() => setActiveTab('consolidado')} className={`flex-1 lg:flex-none flex items-center justify-center gap-3 px-10 py-4 rounded-[2rem] font-black text-[10px] uppercase tracking-widest transition-all ${activeTab === 'consolidado' ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-400 hover:bg-slate-100'}`}>
                <LayoutGrid className="w-4 h-4" /> Global
            </button>
            <button onClick={() => setActiveTab('recepcion')} className={`flex-1 lg:flex-none flex items-center justify-center gap-3 px-10 py-4 rounded-[2rem] font-black text-[10px] uppercase tracking-widest transition-all ${activeTab === 'recepcion' ? 'bg-brand-500 text-white shadow-lg' : 'text-slate-400 hover:bg-slate-100'}`}>
                <Store className="w-4 h-4" /> FeetCare
            </button>
            <button onClick={() => setActiveTab('surco')} className={`flex-1 lg:flex-none flex items-center justify-center gap-3 px-10 py-4 rounded-[2rem] font-black text-[10px] uppercase tracking-widest transition-all ${activeTab === 'surco' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400 hover:bg-slate-100'}`}>
                <MapPin className="w-4 h-4" /> Surco
            </button>
         </div>
      </div>

      {/* INDICADOR DE CARGA */}
      {loading && (
        <div className="bg-brand-500 text-white px-10 py-4 rounded-full w-fit mx-auto flex items-center gap-4 animate-bounce shadow-xl">
           <Loader2 className="w-5 h-5 animate-spin" />
           <span className="text-xs font-black uppercase tracking-widest">{syncProgress}</span>
        </div>
      )}

      {/* KPIs CONTEXTUALES */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm relative overflow-hidden group hover:border-brand-200 transition-all">
             <p className="text-slate-400 text-[9px] font-black uppercase tracking-widest mb-1 flex items-center gap-2"><ArrowDownToLine className="w-3 h-3"/> Venta del Periodo</p>
             <h3 className="text-3xl font-black text-slate-900 tracking-tighter">S/ {currentStats.vBruta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</h3>
             <p className="text-[9px] font-bold text-slate-400 mt-2">Neta (Sin IGV): S/ {currentStats.vNeta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</p>
          </div>
          <div className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm group">
             <p className="text-slate-400 text-[9px] font-black uppercase tracking-widest mb-1 flex items-center gap-2"><Calculator className="w-3 h-3"/> Inversión en Costos</p>
             <h3 className="text-3xl font-black text-slate-400 tracking-tighter">S/ {currentStats.costo.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</h3>
          </div>
          <div className={`p-8 rounded-[2.5rem] shadow-xl text-white transition-all duration-500 ${activeTab === 'recepcion' ? 'bg-brand-500' : activeTab === 'surco' ? 'bg-blue-600' : 'bg-slate-900'}`}>
             <p className="text-white/60 text-[9px] font-black uppercase tracking-widest mb-1">Ganancia Real Auditada</p>
             <h3 className="text-3xl font-black tracking-tighter">S/ {currentStats.mNeta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</h3>
          </div>
          <div className="bg-white p-8 rounded-[2.5rem] border-4 border-slate-50 flex flex-col justify-center">
             <p className="text-slate-400 text-[9px] font-black uppercase tracking-widest mb-1">Rentabilidad</p>
             <h3 className="text-3xl font-black tracking-tighter text-slate-900">{currentStats.rent}%</h3>
          </div>
      </div>

      {/* TABLAS DETALLADAS */}
      <div className="space-y-4">
         {activeTab === 'consolidado' ? (
           <>
              <ReportSection data={dataFeetCare} title="Detalle: Sede FeetCare" totals={statsFeetCare} />
              <ReportSection data={dataFeetSurco} title="Detalle: Sede Surco" totals={statsSurco} />
           </>
         ) : activeTab === 'recepcion' ? (
           <ReportSection data={dataFeetCare} title="Reporte Sede FeetCare" totals={statsFeetCare} />
         ) : (
           <ReportSection data={dataFeetSurco} title="Reporte Sede Surco" totals={statsSurco} />
         )}
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-100 p-8 rounded-[3rem] flex items-center gap-6 text-rose-600 animate-in slide-in-from-top-6 shadow-xl">
          <AlertCircle className="w-8 h-8" />
          <p className="font-bold text-sm uppercase tracking-tight">{error}</p>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
