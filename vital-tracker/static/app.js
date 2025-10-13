// Frontend script for Vital Tracker

(async function(){
  let bpChart = null, pulseChart = null, tempChart = null;
  let tableState = { page: 1, pageSize: 10, sortKey: 'timestamp_nanos', sortDir: 'desc' };
  let lastEntries = [];

  let video = null; 
  // Thumbnails and hidden temporary canvas used for captures
  // note: thumbnail and button elements are queried later (after DOM ready) to avoid null refs
  const tempCanvas = document.createElement('canvas'); tempCanvas.width = 320; tempCanvas.height = 240; const tempCtx = tempCanvas.getContext('2d');
  let captureStep = 0; // 0=front,1=left,2=right,3=neck,4=done
  let capturedBlobs = { front: null, left: null, right: null, neck: null };

  function tsToDate(ts_nanos){ if(!ts_nanos) return null; return new Date(Math.floor(Number(ts_nanos)/1e6)); }

  async function loadEntries(){
    const gallery = document.getElementById('photos_gallery');
    const tbody = document.querySelector('#entries_table tbody');
    if(tbody) tbody.innerHTML = '';
    if(gallery) gallery.innerHTML = '';

    try{
      const r = await fetch('/entries');
      if(!r.ok) throw new Error('HTTP '+r.status);
      const list = await r.json();
  const parsed = list.map(e => ({ path: e.path, sys: Number(e.sys||0), dia: Number(e.dia||0), pulse: Number(e.pulse||0), temp_c: Number(e.temp_c||0), timestamp_nanos: Number(e.timestamp_nanos||0) }));
      parsed.sort((a,b)=> b.timestamp_nanos - a.timestamp_nanos);
  // Cache for exports and other controls
  lastEntries = parsed.slice();

      // Table
      if(tbody){
        const sorted = parsed.slice().sort((a,b)=>{
          const k = tableState.sortKey; const av = a[k]||0; const bv = b[k]||0; if(av===bv) return 0; const dir = tableState.sortDir==='asc'?1:-1; return av<bv? -1*dir:1*dir;
        });
        const total = sorted.length; const pageSize = Number(document.getElementById('tbl_pagesize')?.value || tableState.pageSize);
        const totalPages = Math.max(1, Math.ceil(total/pageSize)); if(tableState.page>totalPages) tableState.page = totalPages;
        const startIdx = (tableState.page-1)*pageSize; const pageItems = sorted.slice(startIdx, startIdx+pageSize);
        document.getElementById('tbl_page') && (document.getElementById('tbl_page').textContent = tableState.page + '/' + totalPages);
        for(const e of pageItems){
          const tr = document.createElement('tr');
          const date = tsToDate(e.timestamp_nanos);
          // Derive base id from photo path to avoid JS Number precision issues on timestamp_nanos
          const tsBase = (()=>{
            try{
              const fname = (e.path||'').split('/').pop()||'';
              return fname.replace(/\.jpg$/i,'');
            }catch(_){ return String(e.timestamp_nanos||''); }
          })();
          tr.innerHTML = `<td>${date?date.toLocaleString():''}</td><td>${e.sys}</td><td>${e.dia}</td><td>${e.pulse}</td><td>${e.temp_c}</td><td><a target="_blank" href="${e.path}">photo</a></td><td><button class="del-btn" data-ts="${tsBase}">Delete</button></td>`;
          tbody.appendChild(tr);
        }
        // Attach delete handlers
        tbody.querySelectorAll('button.del-btn').forEach(btn=>{
          btn.addEventListener('click', async (ev)=>{
            const ts = ev.currentTarget.getAttribute('data-ts');
            if(!ts) return;
            if(!confirm('Delete this entry?')) return;
            try{
              const r = await fetch(`/entry/${encodeURIComponent(ts)}`, { method:'DELETE' });
              if(r.ok){
                await loadEntries();
              } else {
                alert('Delete failed: '+ r.status);
              }
            } catch(e){ alert('Network error: '+ e); }
          });
        });
      }

      // Photo Gallery
      if(gallery){
        for(const e of parsed){
          const div = document.createElement('div');
          const img = document.createElement('img'); img.src = e.path; img.style.maxWidth = '200px'; img.style.margin = '6px';
          const meta = document.createElement('div'); meta.textContent = tsToDate(e.timestamp_nanos) ? tsToDate(e.timestamp_nanos).toLocaleString() : '';
          div.appendChild(meta); div.appendChild(img); gallery.appendChild(div);
        }
      }

      // Charts (Graphs) with view modes
      if(document.getElementById('bpChart')){
        const view = document.getElementById('graph_view_select')?.value || 'full';

        function toMs(nanos){ const d = tsToDate(nanos); return d? d.getTime(): 0; }
        function fmt(dt){ return dt? dt.toLocaleString(): ''; }
        function groupWeekly(items){
          const WEEK = 7*24*60*60*1000;
          const buckets = new Map();
          for(const it of items){
            const ms = toMs(it.timestamp_nanos);
            const start = Math.floor(ms / WEEK) * WEEK;
            if(!buckets.has(start)) buckets.set(start, []);
            buckets.get(start).push(it);
          }
          const keys = Array.from(buckets.keys()).sort((a,b)=> a-b);
          const labels = keys.map(k=> new Date(k));
          const agg = keys.map(k=>{
            const arr = buckets.get(k);
            const avg = (sel)=> arr.length? (arr.reduce((s,x)=> s + Number(sel(x)||0),0) / arr.length) : 0;
            return { sys: avg(x=>x.sys), dia: avg(x=>x.dia), pulse: avg(x=>x.pulse), temp_c: avg(x=>x.temp_c) };
          });
          return { labels: labels.map(fmt), sys: agg.map(x=>x.sys), dia: agg.map(x=>x.dia), pulse: agg.map(x=>x.pulse), temp_c: agg.map(x=>x.temp_c) };
        }

        function groupDaily(items){
          const DAY = 24*60*60*1000;
          const buckets = new Map();
          for(const it of items){
            const ms = toMs(it.timestamp_nanos);
            const start = Math.floor(ms / DAY) * DAY;
            if (!buckets.has(start)) buckets.set(start, []);
            buckets.get(start).push(it);
          }
          const keys = Array.from(buckets.keys()).sort((a,b)=> a-b);
          const labels = keys.map(k=> new Date(k));
          const agg = keys.map(k=>{
            const arr = buckets.get(k);
            const avg = (sel)=> arr.length? (arr.reduce((s,x)=> s + Number(sel(x)||0),0) / arr.length) : 0;
            return { sys: avg(x=>x.sys), dia: avg(x=>x.dia), pulse: avg(x=>x.pulse), temp_c: avg(x=>x.temp_c) };
          });
          return { labels: labels.map(fmt), sys: agg.map(x=>x.sys), dia: agg.map(x=>x.dia), pulse: agg.map(x=>x.pulse), temp_c: agg.map(x=>x.temp_c) };
        }

        // Group by hour-of-day across all days (0..23)
        function groupTimeOfDay(items){
          const buckets = new Map();
          for(let h=0; h<24; h++){ buckets.set(h, []); }
          for(const it of items){
            const ms = toMs(it.timestamp_nanos); if(!ms) continue;
            const d = new Date(ms);
            const h = d.getHours();
            buckets.get(h).push(it);
          }
          const hours = [...Array(24).keys()];
          const labels = hours.map(h=> h.toString().padStart(2,'0') + ':00');
          const aggBy = sel => hours.map(h=>{
            const arr = buckets.get(h);
            if(!arr.length) return null;
            return arr.reduce((s,x)=> s + Number(sel(x)||0),0) / arr.length;
          });
          return {
            labels,
            sys: aggBy(x=>x.sys),
            dia: aggBy(x=>x.dia),
            pulse: aggBy(x=>x.pulse),
            temp_c: aggBy(x=>x.temp_c),
          };
        }

        // Base sorted ascending
        let asc = parsed.slice().sort((a,b)=> a.timestamp_nanos - b.timestamp_nanos);
        let labels, sysData, diaData, pulseData, tempData, extraDatasets = [];

        if(view === '30d'){
          const cutoff = Date.now() - 30*24*60*60*1000;
          asc = asc.filter(e => toMs(e.timestamp_nanos) >= cutoff);
          labels = asc.map(x=> fmt(tsToDate(x.timestamp_nanos)));
          sysData = asc.map(x=>x.sys); diaData = asc.map(x=>x.dia); pulseData = asc.map(x=>x.pulse); tempData = asc.map(x=>x.temp_c);
        } else if(view === '7d_weekly'){
          const g = groupWeekly(asc);
          labels = g.labels; sysData = g.sys; diaData = g.dia; pulseData = g.pulse; tempData = g.temp_c;
        } else if(view === 'daily'){
          const g = groupDaily(asc);
          labels = g.labels; sysData = g.sys; diaData = g.dia; pulseData = g.pulse; tempData = g.temp_c;
        } else if(view === 'tod'){
          const g = groupTimeOfDay(asc);
          labels = g.labels; sysData = g.sys; diaData = g.dia; pulseData = g.pulse; tempData = g.temp_c;
        } else if(view === 'avg_compare'){
          labels = asc.map(x=> fmt(tsToDate(x.timestamp_nanos)));
          sysData = asc.map(x=>x.sys); diaData = asc.map(x=>x.dia); pulseData = asc.map(x=>x.pulse); tempData = asc.map(x=>x.temp_c);
          const mean = arr => arr.length? (arr.reduce((s,v)=> s + Number(v||0),0)/arr.length):0;
          const sysAvg = mean(sysData), diaAvg = mean(diaData), pulseAvg = mean(pulseData), tempAvg = mean(tempData);
          const line = (v)=> labels.map(()=> v);
          extraDatasets = [
            { label:'SYS avg', data: line(sysAvg), borderColor:'rgba(220,20,60,.5)', borderDash:[6,4], fill:false },
            { label:'DIA avg', data: line(diaAvg), borderColor:'rgba(30,144,255,.5)', borderDash:[6,4], fill:false }
          ];
          // For pulse and temp charts we'll add their own avg lines separately
        } else {
          labels = asc.map(x=> fmt(tsToDate(x.timestamp_nanos)));
          sysData = asc.map(x=>x.sys); diaData = asc.map(x=>x.dia); pulseData = asc.map(x=>x.pulse); tempData = asc.map(x=>x.temp_c);
        }

        if(bpChart){ bpChart.destroy(); bpChart = null; }
        if(pulseChart){ pulseChart.destroy(); pulseChart = null; }
        if(tempChart){ tempChart.destroy(); tempChart = null; }

        const bpCtx = document.getElementById('bpChart').getContext('2d');
        const bpDatasets = [
          { label:'SYS', data: sysData, borderColor:'rgb(220,20,60)', fill:false },
          { label:'DIA', data: diaData, borderColor:'rgb(30,144,255)', fill:false },
          ...extraDatasets
        ];
        bpChart = new Chart(bpCtx, { type:'line', data:{ labels, datasets: bpDatasets }, options:{ responsive:true } });

        const pCtx = document.getElementById('pulseChart').getContext('2d');
        let pulseDatasets = [ { label:'Pulse', data: pulseData, borderColor:'rgb(34,139,34)', fill:false } ];
        if(view === 'avg_compare'){
          const mean = arr => arr.length? (arr.reduce((s,v)=> s + Number(v||0),0)/arr.length):0;
          pulseDatasets.push({ label:'Pulse avg', data: labels.map(()=> mean(pulseData)), borderColor:'rgba(34,139,34,.5)', borderDash:[6,4], fill:false });
        }
        pulseChart = new Chart(pCtx, { type:'line', data:{ labels, datasets: pulseDatasets }, options:{ responsive:true } });

        const tCtx = document.getElementById('tempChart').getContext('2d');
        let tempDatasets = [ { label:'Temp (C)', data: tempData, borderColor:'rgb(255,140,0)', fill:false } ];
        if(view === 'avg_compare'){
          const mean = arr => arr.length? (arr.reduce((s,v)=> s + Number(v||0),0)/arr.length):0;
          tempDatasets.push({ label:'Temp avg', data: labels.map(()=> mean(tempData)), borderColor:'rgba(255,140,0,.5)', borderDash:[6,4], fill:false });
        }
        tempChart = new Chart(tCtx, { type:'line', data:{ labels, datasets: tempDatasets }, options:{ responsive:true } });
      }

    } catch(err){
      const target = document.getElementById('photos_gallery') || document.querySelector('#entries_table') || document.getElementById('bpChart');
      if(target){ const p = document.createElement('div'); p.style.color='#900'; p.style.margin='8px 0'; p.textContent = 'Could not load entries (server offline)'; target.parentNode.insertBefore(p, target); }
      else console.warn('Could not load entries', err);
    }
  }

  // CSV export
  function exportCsv(arr, filename){ if(!arr || !arr.length){ alert('No data to export'); return; } const cols = ['timestamp_nanos','sys','dia','pulse','temp_c','path']; const header = cols.join(','); const lines = arr.map(r=> cols.map(c=>{ let v = r[c]===undefined? '': r[c]; if(typeof v === 'string') v = '"'+String(v).replace(/"/g,'""')+'"'; return v; }).join(',')); const csv = [header].concat(lines).join('\n'); const blob = new Blob([csv], { type:'text/csv' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename || 'export.csv'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); }

  // Bind controls that may be injected later (table controls, header sorting, refresh)
  function bindControls(){
    // Table controls
    document.getElementById('tbl_prev')?.addEventListener('click', ()=>{ if(tableState.page>1){ tableState.page--; loadEntries(); } });
    document.getElementById('tbl_next')?.addEventListener('click', ()=>{ tableState.page++; loadEntries(); });
    document.getElementById('tbl_pagesize')?.addEventListener('change', ()=>{ tableState.page = 1; loadEntries(); });

    // Header sorting
    document.querySelectorAll('#entries_table thead th[data-key]').forEach(th=>{ th.style.cursor='pointer'; th.addEventListener('click', ()=>{ const k=th.getAttribute('data-key'); if(tableState.sortKey===k) tableState.sortDir = tableState.sortDir==='asc'?'desc':'asc'; else { tableState.sortKey=k; tableState.sortDir='desc'; } tableState.page=1; loadEntries(); }); });

    // Refresh buttons inside injected pages
    document.querySelectorAll('#refresh_entries').forEach(btn=> btn.addEventListener('click', ()=> loadEntries()));

    // Export buttons
    document.getElementById('export_page')?.addEventListener('click', ()=>{
      if(!lastEntries.length){ alert('No data'); return; }
      const pageSize = Number(document.getElementById('tbl_pagesize')?.value || tableState.pageSize);
      const startIdx = (tableState.page-1)*pageSize; const pageItems = lastEntries.slice(startIdx, startIdx+pageSize);
      exportCsv(pageItems, 'vital_page.csv');
    });
    document.getElementById('export_all')?.addEventListener('click', ()=>{
      if(!lastEntries.length){ alert('No data'); return; }
      exportCsv(lastEntries, 'vital_all.csv');
    });

    // Graph view select (may be injected) - attach here so it works after injection
    const graphSelect = document.getElementById('graph_view_select');
    if(graphSelect) graphSelect.addEventListener('change', ()=> loadEntries());

    // Graph tabs - show one chart at a time
    const tabs = document.querySelectorAll('.graph-tab');
    const bpCard = document.getElementById('bpChart')?.parentElement;
    const pulseCard = document.getElementById('pulseChart')?.parentElement;
    const tempCard = document.getElementById('tempChart')?.parentElement;
    function showTab(tab){
      if(!bpCard || !pulseCard || !tempCard) return;
      bpCard.style.display = (tab==='bp')? 'block':'none';
      pulseCard.style.display = (tab==='pulse')? 'block':'none';
      tempCard.style.display = (tab==='temp')? 'block':'none';
      tabs.forEach(t=> t.classList.toggle('active', t.getAttribute('data-tab')===tab));
    }
    tabs.forEach(t=> t.addEventListener('click', ()=> showTab(t.getAttribute('data-tab'))));
    if(tabs.length){ showTab('bp'); }

    // Dashboard nav fallback (legacy pages)
    document.getElementById('view_graphs')?.addEventListener('click', ()=> location.href='/static/dashboard/graphs.html');
    document.getElementById('view_table')?.addEventListener('click', ()=> location.href='/static/dashboard/table.html');
    document.getElementById('view_photos')?.addEventListener('click', ()=> location.href='/static/dashboard/photos.html');
  }

  // Expose binder so the host page can call it after injecting HTML
  window.vital_bindControls = bindControls;

  // Camera helper: set up camera stream when canvases exist
  async function setupCamera(){
    try{
      if(navigator.mediaDevices && navigator.mediaDevices.getUserMedia){
        const stream = await navigator.mediaDevices.getUserMedia({ video:true, audio:false });
        if(video) video.srcObject = stream;
      }
    }catch(e){
      console.warn('camera not available', e);
      if(video) video.style.display='none';
    }
  }

  function captureTo(ctx){ if(!ctx) return; if(!video || !video.srcObject){ ctx.fillStyle='#ddd'; ctx.fillRect(0,0,ctx.canvas.width, ctx.canvas.height); ctx.fillStyle='#000'; ctx.fillText('No camera',10,20); return; } ctx.drawImage(video,0,0,ctx.canvas.width, ctx.canvas.height); }

  // Capture-cycle button behavior
  function updateCaptureButton(){
    const btn = document.getElementById('cap_cycle'); if(!btn) return;
  if(captureStep===0) btn.textContent = 'Capture Front';
  else if(captureStep===1) btn.textContent = 'Capture Left';
  else if(captureStep===2) btn.textContent = 'Capture Right';
  else if(captureStep===3) btn.textContent = 'Capture Neck';
  else btn.textContent = 'Submit Entry';
  }

  // Submit using captured blobs
  async function doSubmitWithCaptured(){
    const status = document.getElementById('status'); if(status) status.textContent = 'Uploading...';
    const fd = new FormData(); fd.append('sys', document.getElementById('sys').value || ''); fd.append('dia', document.getElementById('dia').value || ''); fd.append('pulse', document.getElementById('pulse').value || ''); fd.append('temp', document.getElementById('temp').value || '');
  if(capturedBlobs.front) fd.append('photo_front', new File([capturedBlobs.front], 'front.png', { type:'image/png' }));
  if(capturedBlobs.left) fd.append('photo_left', new File([capturedBlobs.left], 'left.png', { type:'image/png' }));
  if(capturedBlobs.right) fd.append('photo_right', new File([capturedBlobs.right], 'right.png', { type:'image/png' }));
  if(capturedBlobs.neck) fd.append('photo_neck', new File([capturedBlobs.neck], 'neck.png', { type:'image/png' }));
    try{
      const res = await fetch('/entry',{ method:'POST', body: fd });
      if(res.ok){
        status && (status.textContent='Saved');
        try{ document.title = 'VITAL_OK_CLOSE'; }catch(_){ }
        // Attempt to close the window if this tab was opened by our hotkey launcher
        setTimeout(()=>{
          try{
            if(window.close){ window.close(); }
          }catch(_){ }
          // Fallback: navigate away if close was blocked
          try{ location.href = '/'; }catch(_){}
        }, 200);
      } else {
        status && (status.textContent = 'Error: '+ await res.text());
      }
    } catch(e){ status && (status.textContent = 'Network error: '+e); }
  }

  // Submit (legacy submit button) - also supports direct submit without using cycle button
  async function combineCapturedAndSubmit(){
    const status = document.getElementById('status'); if(status) status.textContent = 'Uploading...';
    // ensure we have at least one captured image
  if(!capturedBlobs.front && !capturedBlobs.left && !capturedBlobs.right && !capturedBlobs.neck){ if(status) status.textContent = 'No photos captured'; return; }
  // create combined canvas (horizontal strip)
  const w = 320, h = 240;
  const images = [capturedBlobs.front, capturedBlobs.left, capturedBlobs.right, capturedBlobs.neck].filter(Boolean);
  const canvas = document.createElement('canvas'); canvas.width = w * images.length; canvas.height = h; const ctx = canvas.getContext('2d');
    // helper to draw blob into a slot
    async function drawBlobAt(blob, x){ if(!blob) return; const img = new Image(); const url = URL.createObjectURL(blob); await new Promise((res, rej)=>{ img.onload = ()=>{ ctx.drawImage(img, x, 0, w, h); URL.revokeObjectURL(url); res(); }; img.onerror = (e)=>{ URL.revokeObjectURL(url); res(); }; img.src = url; }); }
  let xoff = 0; for (const imgBlob of images){ await drawBlobAt(imgBlob, xoff); xoff += w; }
    const combinedBlob = await new Promise(res=> canvas.toBlob(res, 'image/png'));

    const fd = new FormData(); fd.append('sys', document.getElementById('sys').value || ''); fd.append('dia', document.getElementById('dia').value || ''); fd.append('pulse', document.getElementById('pulse').value || ''); fd.append('temp', document.getElementById('temp').value || '');
  if(capturedBlobs.front) fd.append('photo_front', new File([capturedBlobs.front], 'front.png', { type:'image/png' }));
  if(capturedBlobs.left) fd.append('photo_left', new File([capturedBlobs.left], 'left.png', { type:'image/png' }));
  if(capturedBlobs.right) fd.append('photo_right', new File([capturedBlobs.right], 'right.png', { type:'image/png' }));
  if(capturedBlobs.neck) fd.append('photo_neck', new File([capturedBlobs.neck], 'neck.png', { type:'image/png' }));
    if(combinedBlob) fd.append('photo_combined', new File([combinedBlob], 'combined.png', { type:'image/png' }));

    try{
      const res = await fetch('/entry',{ method:'POST', body: fd });
      if(res.ok){
        status && (status.textContent='Saved');
        try{ document.title = 'VITAL_OK_CLOSE'; }catch(_){ }
        
  captureStep = 0; capturedBlobs = { front:null,left:null,right:null,neck:null }; const statusEl = document.getElementById('cap_status'); if(statusEl) statusEl.textContent = '0 / 4 captured'; const btn = document.getElementById('cap_cycle'); if(btn) { btn.disabled = false; updateCaptureButton(); }

        setTimeout(()=>{
          try{ if(window.close){ window.close(); } }catch(_){}
          try{ location.href='/'; }catch(_){}
        }, 200);
      } else { status && (status.textContent = 'Error: '+ await res.text()); }
    } catch(e){ status && (status.textContent = 'Network error: '+e); }
  }

  document.getElementById('submit')?.addEventListener('click', async ()=>{
    await combineCapturedAndSubmit();
  });

  // Auto-load on dashboard pages or when dashboard elements are present
  if(window.location.pathname.startsWith('/static/dashboard') || document.querySelector('#entries_table') || document.getElementById('photos_gallery') || document.getElementById('bpChart')){
    try{ bindControls(); }catch(e){}
    loadEntries();
  }

  window.vital_loadEntries = loadEntries;

  // Wrap the binder so it initializes capture button and camera when DOM is ready
  (function(){
    const orig = window.vital_bindControls;
    window.vital_bindControls = function(){
      try{ updateCaptureButton(); }catch(e){}
      // ensure we have fresh DOM references
      video = document.getElementById('video');
      const btn = document.getElementById('cap_cycle');
      if(btn){
        btn.addEventListener('click', async ()=>{
          if(captureStep < 4){
            if(video && (video.srcObject || video.readyState >= 2)){
              tempCanvas.width = 320; tempCanvas.height = 240; tempCtx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
              const blob = await new Promise(res=> tempCanvas.toBlob(res, 'image/png'));
              if(captureStep===0) capturedBlobs.front = blob;
              else if(captureStep===1) capturedBlobs.left = blob;
              else if(captureStep===2) capturedBlobs.right = blob;
              else if(captureStep===3) capturedBlobs.neck = blob;
              captureStep++;

              const statusEl = document.getElementById('cap_status'); if(statusEl) statusEl.textContent = `${captureStep} / 4 captured`;
              updateCaptureButton();
              if(captureStep>=4){ btn.disabled = true; }
            } else {
              alert('Camera not available');
            }
          } else {
          }
        });
      }

      try{ setupCamera(); }catch(e){}
      try{ if(typeof orig === 'function') orig(); }catch(e){}
    };
  })();
})();
