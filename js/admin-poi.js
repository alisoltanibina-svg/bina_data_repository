// Collection controls only observe durable worker state; this page never starts a worker.
(() => {
    const $ = id => document.getElementById(id);
    const labels = {not_configured:'پیکربندی نشده',idle:'بدون برنامهٔ فعال',running:'در حال اجرا',waiting:'در انتظار',pausing:'در حال توقف',paused:'متوقف',interrupted:'ارتباط پردازشگر قطع شده',pending:'در صف',completed:'جست‌وجوهای برنامه تمام شده',needs_review:'نیازمند بررسی',successful:'موفق',failed:'ناموفق',uncertain:'نامطمئن',dispatched:'ارسال‌شده',initial:'اولیه',refresh:'به‌روزرسانی'};
    const titles = {mosque:'مسجد',formal_school:'مدرسه',school:'مؤسسهٔ آموزشی',library:'کتابخانه',park:'بوستان',hospital:'بیمارستان',cinema:'سینما',theater:'تئاتر',university:'دانشگاه'};
    const num = n => Number(n || 0).toLocaleString('fa-IR');
    const time = t => t ? new Date(t).toLocaleString('fa-IR', {timeZone:'Asia/Tehran'}) : '—';
    let loadPromise = null, actionBusy = false, lastStatus = null, jobId = '', layersLoaded = false;
    const readinessMessages = {
        missing_service_key: 'کلید سرویس نشان هنوز تنظیم نشده است؛ گردآوری قابل شروع نیست. پس از فعال‌سازی دسترسی، NESHAN_SERVICE_API_KEY را روی سرور تنظیم کنید.',
        no_active_job: 'برنامهٔ فعالی وجود ندارد. برای آماده‌سازی، بخش «ساخت برنامهٔ سراسری جدید» را باز کنید. ساخت برنامه به نشان درخواستی نمی‌فرستد.',
        worker_not_running: 'پردازشگر گردآوری اجرا نشده یا ارتباط آن قطع است. برای ادامه، ابتدا پردازشگر جداگانه را روی سرور اجرا کنید.'
    };
    function updateControls() {
        $('poi-pause').disabled = actionBusy || !lastStatus || !lastStatus.can_pause;
        $('poi-resume').disabled = actionBusy || !lastStatus || !lastStatus.can_resume;
        $('poi-retry').disabled = actionBusy || !lastStatus || !lastStatus.job || !!lastStatus.in_flight;
        $('poi-pause').title = lastStatus && !lastStatus.can_pause ? 'گردآوری فعالی برای توقف وجود ندارد یا قبلاً متوقف شده است.' : '';
        $('poi-resume').title = lastStatus ? (readinessMessages[lastStatus.resume_blocked_reason] || '') : '';
    }
    function error(err) { $('poi-error').hidden = false; $('poi-error').textContent = err.message || 'دریافت گزارش ممکن نشد.'; }
    function card(title, value) {
        const item = document.createElement('article'); item.className = 'admin-ops-card';
        const heading = document.createElement('h3'); heading.textContent = title;
        const body = document.createElement('p'); body.className = 'admin-stat-value'; body.textContent = value;
        item.append(heading, body); $('poi-summary').append(item);
    }
    function render(data) {
        lastStatus = data;
        const job = data.job; jobId = job ? job.id : '';
        $('poi-readiness').textContent = readinessMessages[data.resume_blocked_reason] || (data.paused ? 'گردآوری متوقف است؛ برای ادامه از دکمهٔ «ادامهٔ گردآوری» استفاده کنید.' : 'گردآوری برای پردازش برنامهٔ فعال آماده است.');
        $('poi-worker').textContent = 'وضعیت: ' + (labels[data.state] || data.state) + ' · پردازشگر: ' + (data.worker_alive ? 'متصل' : 'قطع / اجرا نشده');
        $('poi-timing').textContent = 'آخرین ضربان: ' + time(data.heartbeat_at) + ' · زودترین درخواست بعدی: ' + time(data.next_request_at);
        const reasonLabels = {'No worker or job yet':'هنوز پردازشگر یا برنامه‌ای ثبت نشده است.', 'Paused by administrator':'گردآوری با درخواست مدیر متوقف شده است.', 'New job ready; resume to begin':'برنامهٔ جدید آماده است؛ پس از آماده‌شدن کلید و پردازشگر می‌توانید گردآوری را ادامه دهید.', 'NESHAN_SERVICE_API_KEY is not configured':'کلید سرویس نشان تنظیم نشده است.'};
        $('poi-reason').textContent = reasonLabels[data.reason] || data.reason || '';
        updateControls();
        $('poi-summary').replaceChildren();
        const requests = job ? job.requests : [];
        const total = kind => requests.filter(r => r.kind === kind).reduce((sum,r) => sum+r.count,0);
        card('درخواست Nearby',num(total('nearby'))); card('درخواست جزئیات',num(total('details')));
        card('مکان یکتای ذخیره‌شده',num(data.unique_saved));
        for (const outcome of ['successful','failed','uncertain','dispatched']) {
            card('درخواست ' + labels[outcome],num(requests.filter(r => r.outcome === outcome).reduce((sum,r)=>sum+r.count,0)));
        }
        card('هش تکراری؛ درخواست جلوگیری‌شده',num(job && job.duplicates_skipped));
        card('نامزد مکان تکراری برای بررسی',num(data.duplicate_reviews));
        card('نتیجه بدون هش قابل استفاده',num(job && job.missing_hashes));
        const areas = job ? job.areas : [], grouped = new Map();
        areas.forEach(row => { const entry = grouped.get(row.province) || {complete:0,pending:0,failed:0,uncertain:0}; entry[row.status] = (entry[row.status] || 0)+row.count; grouped.set(row.province,entry); });
        const complete = areas.filter(r=>r.status==='complete').reduce((sum,r)=>sum+r.count,0);
        const totalAreas = areas.reduce((sum,r)=>sum+r.count,0);
        $('poi-coverage').textContent = job ? `${labels[job.status] || job.status} · استان‌های تمام‌شده: ${num(job.completed_provinces)} · باقی‌مانده: ${num(job.remaining_provinces)} · برنامه‌ریزی‌شده: ${num(job.planned_provinces)} از ۳۱ · جست‌وجوهای تمام‌شده: ${num(complete)} از ${num(totalAreas)} ناحیه / دستهٔ برنامه‌ریزی‌شده · نواحی علامت‌گذاری‌شده برای بررسی: ${num(job.flagged_segments)} · جزئیات در صف: ${num(job.details.pending)} · جزئیات ناموفق / نامطمئن: ${num((job.details.failed || 0)+(job.details.uncertain || 0))}` : 'هنوز برنامه‌ای ساخته نشده است.';
        $('poi-areas').replaceChildren();
        grouped.forEach((r,name)=> { const tr = document.createElement('tr'); [name,num(r.complete),num(r.pending),num(r.failed+r.uncertain)].forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.append(td);});$('poi-areas').append(tr); });
        $('poi-categories').replaceChildren();
        data.categories.forEach(row=>{const li=document.createElement('li');li.textContent=(titles[row.category] || row.category)+': '+num(row.unique_saved);$('poi-categories').append(li);});
    }
    function load() {
        if (loadPromise) return loadPromise;
        loadPromise = (async () => {
            try {
                $('poi-error').hidden = true;
                render(await adminFetch('/api/admin/poi/status'));
                if (!layersLoaded) {
                    const layers = await adminFetch('/api/admin/poi/categories');
                    layers.forEach(slug=>{const option=document.createElement('option');option.value=slug;option.textContent=titles[slug] || slug;option.selected=['mosque','formal_school','library','park','hospital'].includes(slug);$('poi-layers').append(option);});
                    layersLoaded = true;
                }
            } catch (err) { error(err); }
            finally { loadPromise = null; }
        })();
        return loadPromise;
    }
    async function action(button, path, body) {
        if (actionBusy) return;
        actionBusy = true;
        button.disabled = true;
        updateControls();
        try {
            await adminFetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body || {})});
            // Finish any older poll, then fetch the state after this mutation.
            if (loadPromise) await loadPromise;
            await load();
        } catch(err) { error(err); }
        finally {
            actionBusy = false;
            button.disabled = false;
            updateControls();
        }
    }
    $('poi-pause').onclick = () => action($('poi-pause'),'/api/admin/poi/pause');
    $('poi-resume').onclick = () => action($('poi-resume'),'/api/admin/poi/resume');
    $('poi-refresh').onclick = load;
    $('poi-mode').onchange = () => { const refresh=$('poi-mode').value==='refresh';$('poi-cutoff-wrap').hidden=!refresh;$('poi-cutoff').required=refresh; };
    $('poi-create').onsubmit = event => {
        event.preventDefault();
        const body = {categories:Array.from($('poi-layers').selectedOptions,o=>o.value),radius_m:Number($('poi-radius').value),mode:$('poi-mode').value};
        if (body.mode==='refresh') body.refresh_before=new Date($('poi-cutoff').value).toISOString();
        action(event.submitter,'/api/admin/poi/jobs',body);
    };
    $('poi-retry').onclick = () => {
        if (jobId && window.confirm('ممکن است درخواست نامطمئن قبلاً به سرویس رسیده باشد. موارد حل‌نشده دوباره در صف قرار گیرند؟')) action($('poi-retry'),'/api/admin/poi/jobs/'+encodeURIComponent(jobId)+'/retry-unresolved');
    };
    $('poi-history-load').onclick = async () => {
        try {
            const [requests,reviews] = await Promise.all([adminFetch('/api/admin/poi/requests'+(jobId?'?job_id='+encodeURIComponent(jobId):'')),adminFetch('/api/admin/poi/duplicate-reviews')]);
            $('poi-history').replaceChildren(); $('poi-raw').textContent='';
            requests.forEach(row=>{const li=document.createElement('li');const button=document.createElement('button');button.type='button';button.textContent=`${row.id} · ${row.kind} · ${labels[row.outcome] || row.outcome} · ${row.http_status || '—'} · ${time(row.started_at)}`;button.onclick=async()=>{try{$('poi-raw').textContent=JSON.stringify(await adminFetch('/api/admin/poi/requests/'+row.id),null,2);}catch(err){error(err);}};li.append(button);$('poi-history').append(li);});
            $('poi-reviews').replaceChildren();reviews.forEach(row=>{const li=document.createElement('li');li.textContent=row.place_id+' / '+row.other_place_id+' · '+row.reason;$('poi-reviews').append(li);});
        } catch(err) { error(err); }
    };
    // Polling is read-only and stops while this view or browser tab is hidden.
    setInterval(()=>{if (!document.hidden && !$('view-poi').hidden) load();},5000);
    updateControls();
    window.AdminPoi = {load};
})();
