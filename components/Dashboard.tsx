
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { 
  TrendingUp, RefreshCw, AlertCircle, LayoutGrid, Store, MapPin, 
  Loader2, ArrowDownToLine, Calculator, ShieldCheck, ReceiptText, 
  Calendar, ChevronLeft, ChevronRight, AlertTriangle, ArrowRight,
  Clock, Filter, DatabaseZap, SearchSlash, Terminal
} from 'lucide-react';
import { Venta, OdooSession } from '../types';
import { OdooClient } from '../services/odoo';

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
  
  const today = new Date();
  const [selectedMonth, setSelectedMonth] = useState(today.getMonth());
  const [selectedYear, setSelectedYear] = useState(today.getFullYear());
  const [customRange, setCustomRange] = useState({
    start: new Date(today.getFullYear(), today.getMonth(), 1).toLocaleDateString('en-CA'),
    end: today.toLocaleDateString('en-CA')
  });

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
      setSyncProgress('Autenticando Odoo 14...');

      try {
          const client = new OdooClient(session.url, session.db);
          // CONTEXTO CRÍTICO PARA ODOO 14: Sin esto, los campos de propiedad (costo) devuelven 0
          const odooContext = { 
            company_id: session.companyId, 
            force_company: session.companyId,
            allowed_company_ids: [session.companyId],
            pricelist: 1 // Opcional, para asegurar lectura de precios
          };
          
          setSyncProgress('Extrayendo Pedidos...');
          const domain: any[] = [
            ['state', 'in', ['paid', 'done', 'invoiced']], 
            ['date_order', '>=', `${dateRange.start} 00:00:00`],
            ['date_order', '<=', `${dateRange.end} 23:59:59`]
          ];
          if (session.companyId) domain.push(['company_id', '=', session.companyId]);

          const orders = await client.searchRead(session.uid, session.apiKey, 'pos.order', domain, 
            ['date_order', 'config_id', 'lines', 'user_id'], 
            { order: 'date_order desc', context: odooContext }
          );

          if (!orders || orders.length === 0) {
              setVentasData([]);
              setSyncProgress('Sin ventas encontradas');
              setLoading(false);
              return;
          }

          setSyncProgress(`Analizando ${orders.length} pedidos...`);
          const allLineIds = orders.flatMap((o: any) => o.lines || []);
          
          // ODOO 14 FIX: Eliminamos 'purchase_price' porque no es estándar
          const linesData = await client.searchRead(session.uid, session.apiKey, 'pos.order.line', 
            [['id', 'in', allLineIds]], 
            ['product_id', 'qty', 'price_subtotal', 'price_subtotal_incl', 'order_id'],
            { context: odooContext }
          );

          const productIds = Array.from(new Set(linesData.map((l: any) => l.product_id[0])));
          
          setSyncProgress('Recuperando Costos Reales...');
          // En Odoo 14, standard_price es una propiedad que depende de la compañía en el contexto
          const products = await client.searchRead(
            session.uid, session.apiKey, 'product.product', 
            [['id', 'in', productIds]], 
            ['standard_price', 'categ_id', 'product_tmpl_id'],
            { context: odooContext }
          );

          // Fallback: Si el costo de la variante es 0, buscamos en el template
          const zeroCostTmplIds = products
            .filter((p: any) => (p.standard_price || 0) === 0)
            .map((p: any) => p.product_tmpl_id[0]);

          let templateCosts = new Map<number, number>();
          if (zeroCostTmplIds.length > 0) {
            setSyncProgress('Auditando Plantillas...');
            const templates = await client.searchRead(
              session.uid, session.apiKey, 'product.template',
              [['id', 'in', Array.from(new Set(zeroCostTmplIds))]],
              ['standard_price'],
              { context: odooContext }
            );
            templates.forEach((t: any) => templateCosts.set(t.id, t.standard_price || 0));
          }
          
          const productMap = new Map<number, { cost: number; cat: string }>();
          products.forEach((p: any) => {
              let cost = p.standard_price || 0;
              // Si la variante es 0, intentar el costo de la plantilla
              if (cost === 0 && templateCosts.has(p.product_tmpl_id[0])) {
                cost = templateCosts.get(p.product_tmpl_id[0]) || 0;
              }
              productMap.set(p.id, { 
                cost, 
                cat: Array.isArray(p.categ_id) ? p.categ_id[1] : 'S/C' 
              });
          });
          
          const linesByOrder = new Map();
          linesData.forEach((l: any) => {
              const oId = l.order_id[0];
              if (!linesByOrder.has(oId)) linesByOrder.set(oId, []);
              linesByOrder.get(oId).push(l);
          });

          const mapped: Venta[] = orders.flatMap((o: any) => {
              const orderLines = linesByOrder.get(o.id) || [];
              const orderDate = new Date(o.date_order.replace(' ', 'T') + 'Z');
              const sede = Array.isArray(o.config_id) ? o.config_id[1] : 'Caja Central';

              return orderLines.map((l: any) => {
                  const pId = l.product_id[0];
                  const pInfo = productMap.get(pId) || { cost: 0, cat: 'S/C' };
                  
                  const ventaNeta = l.price_subtotal || 0; 
                  const ventaTotal = l.price_subtotal_incl || 0;
                  const costoTotal = pInfo.cost * l.qty;
                  
                  return {
                      fecha: orderDate,
                      sede,
                      compania: session.companyName || '',
                      vendedor: Array.isArray(o.user_id) ? o.user_id[1] : 'Usuario',
                      producto: Array.isArray(l.product_id) ? l.product_id[1] : 'Producto',
                      categoria: pInfo.cat,
                      total: ventaTotal, 
                      subtotal: ventaNeta,
                      costo: costoTotal,
                      margen: ventaNeta - costoTotal,
                      margenBruto: ventaTotal - costoTotal,
                      cantidad: l.qty,
                      sesion: '', 
                      metodoPago: '-',
                      margenPorcentaje: ventaNeta > 0 ? (((ventaNeta - costoTotal) / ventaNeta) * 100).toFixed(1) : '0.0'
                  };
              });
          });

          setVentasData(mapped);
          setSyncProgress('Cuadrado Exitoso');
      } catch (err: any) {
          setError(err.message);
      } finally {
          setLoading(false);
      }
  }, [session, dateRange]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const stats = useMemo(() => {
    const filterBySede = (data: Venta[], name: string) => data.filter(v => v.sede.toUpperCase().includes(name.toUpperCase()));
    const dataFC = filterBySede(ventasData, 'FEETCARE').concat(filterBySede(ventasData, 'RECEPCION'));
    const dataSurco = filterBySede(ventasData, 'SURCO');

    const calc = (d: Venta[]) => {
      const vBruta = d.reduce((s, x) => s + x.total, 0);
      const vNeta = d.reduce((s, x) => s + x.subtotal, 0);
      const cost = d.reduce((s, x) => s + x.costo, 0);
      const mNeta = d.reduce((s, x) => s + x.margen, 0);
      const mBruta = d.reduce((s, x) => s + x.margenBruto, 0);
      return { 
        vBruta, vNeta, cost, mNeta, mBruta, 
        rent: vNeta > 0 ? ((mNeta / vNeta) * 100).toFixed(1) : '0.0',
        missingCosts: d.filter(x => x.costo <= 0).length
      };
    };

    return {
      global: calc(ventasData),
      feetcare: calc(dataFC),
      surco: calc(dataSurco),
      dataFC, dataSurco
    };
  }, [ventasData]);

  const currentStats = activeTab === 'recepcion' ? stats.feetcare : activeTab === 'surco' ? stats.surco : stats.global;
  const currentData = activeTab === 'recepcion' ? stats.dataFC : activeTab === 'surco' ? stats.dataSurco : ventasData;

  const meses = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

  return (
    <div className="p-4 md:p-8 font-sans max-w-7xl mx-auto space-y-8 animate-in fade-in pb-32">
      
      {/* HEADER DE AUDITORÍA */}
      <div className="bg-white p-8 rounded-[3rem] shadow-2xl border border-slate-100 space-y-8">
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-6">
          <div className="flex items-center gap-4">
             <div className="p-4 bg-slate-900 rounded-3xl shadow-xl shadow-brand-500/10"><DatabaseZap className="text-brand-400 w-8 h-8" /></div>
             <div>
                <h1 className="text-4xl font-black text-slate-900 uppercase tracking-tighter italic leading-none">Lemon BI <span className="text-brand-500">Odoo 14</span></h1>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-2 flex items-center gap-2">
                  <Terminal size={12} className="text-brand-500"/> Modo: Auditoría de Costos por Contexto (v14)
                </p>
             </div>
          </div>
          <button onClick={fetchData} disabled={loading} className="w-full lg:w-auto flex items-center justify-center gap-3 bg-brand-500 text-white px-10 py-5 rounded-2xl font-black text-xs hover:bg-brand-600 transition-all uppercase tracking-widest shadow-xl shadow-brand-500/20">
             <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Sincronizar Ahora
          </button>
        </div>

        {/* SELECTORES DE TIEMPO */}
        <div className="flex flex-col md:flex-row items-center justify-between gap-6 p-2 bg-slate-50 rounded-[2.5rem] border border-slate-100">
           <div className="flex bg-white p-1.5 rounded-2xl shadow-inner w-full md:w-auto">
             {(['hoy', 'mes', 'anio', 'custom'] as FilterMode[]).map(m => (
               <button key={m} onClick={() => setFilterMode(m)} className={`px-8 py-3.5 rounded-xl text-[10px] font-black uppercase transition-all ${filterMode === m ? 'bg-slate-900 text-white shadow-lg' : 'text-slate-400 hover:text-slate-600'}`}>
                  {m === 'hoy' ? 'HOY' : m === 'mes' ? 'MES' : m === 'anio' ? 'AÑO' : 'RANGO'}
               </button>
             ))}
           </div>

           <div className="flex items-center gap-6 px-10">
              {filterMode === 'mes' && (
                <div className="flex items-center gap-8">
                   <button onClick={() => setSelectedMonth(m => m === 0 ? 11 : m - 1)} className="p-2 hover:bg-white rounded-full transition-all text-slate-400"><ChevronLeft/></button>
                   <span className="text-sm font-black text-slate-900 uppercase italic min-w-[140px] text-center">{meses[selectedMonth]} {selectedYear}</span>
                   <button onClick={() => setSelectedMonth(m => m === 11 ? 0 : m + 1)} className="p-2 hover:bg-white rounded-full transition-all text-slate-400"><ChevronRight/></button>
                </div>
              )}
              {filterMode === 'hoy' && <span className="text-sm font-black text-brand-600 uppercase italic">Fecha: {today.toLocaleDateString()}</span>}
           </div>
        </div>
      </div>

      {/* KPIs DE RESULTADOS */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="bg-white p-8 rounded-[3rem] border border-slate-100 shadow-sm relative overflow-hidden">
             <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mb-1 flex items-center gap-2"><ArrowDownToLine className="w-3 h-3"/> Venta Bruta (Caja)</p>
             <h3 className="text-4xl font-black text-slate-900 tracking-tighter">S/ {currentStats.vBruta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</h3>
             <div className="absolute top-0 right-0 w-24 h-24 bg-brand-50 rounded-bl-[4rem] flex items-center justify-center -mr-8 -mt-8 opacity-20"><ArrowDownToLine className="text-brand-500 w-8 h-8 ml-2 mt-2" /></div>
          </div>
          <div className={`p-8 rounded-[3rem] border shadow-sm transition-all ${currentStats.missingCosts > 0 ? 'bg-rose-50 border-rose-100' : 'bg-white border-slate-100'}`}>
             <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mb-1 flex items-center gap-2"><Calculator className="w-3 h-3"/> Costo Total Auditado</p>
             <h3 className={`text-4xl font-black tracking-tighter ${currentStats.cost === 0 ? 'text-rose-500' : 'text-slate-900'}`}>S/ {currentStats.cost.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</h3>
             {currentStats.missingCosts > 0 && (
               <p className="text-[9px] font-black text-rose-600 mt-2 uppercase flex items-center gap-1.5 animate-pulse">
                 <AlertTriangle size={12}/> {currentStats.missingCosts} productos con costo S/ 0.00 en Odoo
               </p>
             )}
          </div>
          <div className="bg-slate-900 p-8 rounded-[3rem] shadow-2xl text-white">
             <p className="text-slate-500 text-[10px] font-black uppercase tracking-widest mb-1">Utilidad Neta (Neto - Costo)</p>
             <h3 className="text-4xl font-black tracking-tighter text-brand-400">S/ {currentStats.mNeta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</h3>
             <p className="text-[10px] font-black text-white/30 mt-2 uppercase">Margen Real: {currentStats.rent}%</p>
          </div>
          <div className="bg-brand-500 p-8 rounded-[3rem] shadow-xl shadow-brand-500/20 text-white">
             <p className="text-white/70 text-[10px] font-black uppercase tracking-widest mb-1">Caja Neta Disponible</p>
             <h3 className="text-4xl font-black tracking-tighter">S/ {currentStats.mBruta.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</h3>
          </div>
      </div>

      {/* TABLA DE AUDITORÍA */}
      <div className="space-y-8">
        <div className="flex bg-slate-100 p-1.5 rounded-full border border-slate-200 gap-2 w-fit mx-auto shadow-inner">
            {(['consolidado', 'recepcion', 'surco'] as ReportTab[]).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} className={`px-12 py-4 rounded-full font-black text-[10px] uppercase tracking-widest transition-all ${activeTab === tab ? 'bg-slate-900 text-white shadow-xl' : 'text-slate-400 hover:text-slate-600'}`}>
                {tab === 'consolidado' ? 'Global' : tab === 'recepcion' ? 'FeetCare' : 'Surco'}
              </button>
            ))}
        </div>

        <div className="bg-white rounded-[3rem] border border-slate-200 shadow-2xl overflow-hidden">
          <div className="px-12 py-10 bg-slate-50 border-b border-slate-100 flex justify-between items-center">
            <h3 className="text-2xl font-black text-slate-900 uppercase tracking-tighter flex items-center gap-3 italic">
              <ReceiptText className="text-brand-500 w-8 h-8" /> Auditoría de Línea por Producto
            </h3>
            <div className="px-5 py-2.5 bg-white border border-slate-200 rounded-2xl shadow-sm text-right">
               <span className="text-[9px] font-black text-slate-400 uppercase block leading-none mb-1">Total Registros</span>
               <span className="text-lg font-black text-slate-900 leading-none">{currentData.length}</span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-slate-50/50 text-[11px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
                <tr>
                  <th className="px-12 py-8">Producto / Fecha</th>
                  <th className="px-12 py-8 text-right">Venta Bruta</th>
                  <th className="px-12 py-8 text-right">Costo Auditado</th>
                  <th className="px-12 py-8 text-right">Utilidad</th>
                  <th className="px-12 py-8 text-center">Rent %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {currentData.map((v, i) => (
                  <tr key={i} className={`hover:bg-slate-50 transition-all ${v.costo <= 0 ? 'bg-rose-50/30' : ''}`}>
                    <td className="px-12 py-6">
                       <p className="font-black text-slate-900 text-[12px] uppercase leading-tight">{v.producto}</p>
                       <p className="text-[9px] text-slate-400 font-bold mt-1.5 uppercase flex items-center gap-2 tracking-tighter">
                         {v.fecha.toLocaleDateString('es-PE')} <span className="text-slate-200">|</span> {v.sede} <span className="text-slate-200">|</span> {v.categoria}
                       </p>
                    </td>
                    <td className="px-12 py-6 text-right font-black text-slate-900 text-sm">S/ {v.total.toFixed(2)}</td>
                    <td className={`px-12 py-6 text-right font-bold text-sm ${v.costo <= 0 ? 'text-rose-500' : 'text-slate-300 italic'}`}>
                       S/ {v.costo.toFixed(2)}
                    </td>
                    <td className="px-12 py-6 text-right font-black text-brand-600 text-sm bg-brand-50/10">S/ {v.margen.toFixed(2)}</td>
                    <td className="px-12 py-6 text-center">
                       <span className={`text-[10px] font-black px-4 py-2 rounded-xl ${Number(v.margenPorcentaje) >= 100 || v.costo <= 0 ? 'bg-rose-100 text-rose-700' : 'bg-brand-50 text-brand-700'}`}>
                          {v.margenPorcentaje}%
                       </span>
                    </td>
                  </tr>
                ))}
                {currentData.length === 0 && (
                  <tr><td colSpan={5} className="px-12 py-40 text-center text-slate-300 font-black uppercase tracking-[0.4em] italic flex items-center justify-center gap-5 opacity-40"> <SearchSlash size={32}/> Sin datos en el periodo seleccionado </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {loading && (
        <div className="fixed bottom-12 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-12 py-6 rounded-3xl shadow-2xl flex items-center gap-6 animate-bounce z-50 border border-slate-700">
           <Loader2 className="w-7 h-7 animate-spin text-brand-500" />
           <div className="flex flex-col">
              <span className="text-xs font-black uppercase tracking-widest italic leading-none">{syncProgress}</span>
              <span className="text-[8px] text-slate-500 font-bold uppercase mt-1 tracking-tighter">API V14 XML-RPC GATEWAY</span>
           </div>
        </div>
      )}

      {error && (
        <div className="bg-rose-50 border border-rose-200 p-12 rounded-[3.5rem] flex items-center gap-10 text-rose-600 shadow-2xl animate-in slide-in-from-top-12">
          <div className="p-5 bg-rose-100 rounded-3xl"><AlertCircle className="w-12 h-12" /></div>
          <div className="max-w-xl">
            <p className="font-black text-2xl uppercase tracking-tighter mb-2">Error Crítico Odoo 14</p>
            <p className="text-sm font-medium opacity-90 leading-relaxed font-mono bg-white p-4 rounded-2xl border border-rose-100 overflow-x-auto">{error}</p>
            <button onClick={fetchData} className="mt-6 px-8 py-3 bg-rose-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-rose-700 transition-colors">Reintentar Conexión</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
