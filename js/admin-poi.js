// Collection controls only observe durable worker state; this page never starts a worker.
(() => {
    const $ = id => document.getElementById(id);
    const labels = {not_configured:'پیکربندی نشده',idle:'بدون برنامهٔ فعال',running:'در حال اجرا',waiting:'در انتظار',pausing:'در حال توقف',paused:'متوقف',interrupted:'ارتباط پردازشگر قطع شده',pending:'در صف',completed:'جست‌وجوهای برنامه تمام شده',needs_review:'نیازمند بررسی',successful:'موفق',failed:'ناموفق',uncertain:'نامطمئن',dispatched:'ارسال‌شده',initial:'اولیه',refresh:'به‌روزرسانی',complete:'پایان‌یافته',processing:'در حال دریافت جزئیات',cancelled:'جایگزین شده'};
    const titles = {mosque:'مسجد',formal_school:'مدرسه',school:'مؤسسهٔ آموزشی',library:'کتابخانه',park:'بوستان',hospital:'بیمارستان',cinema:'سینما',theater:'تئاتر',university:'دانشگاه'};
    const num = n => Number(n || 0).toLocaleString('fa-IR');
    const time = t => t ? new Date(t).toLocaleString('fa-IR', {timeZone:'Asia/Tehran'}) : '—';
    let loadPromise = null, actionBusy = false, lastStatus = null, jobId = '', layersLoaded = false, pilotCategoriesKey = '', sourceKey = '', pointKey = '', sourcePoints = [];
    const readinessMessages = {
        pilot_required: 'برای ادامه ابتدا یک آزمایش تک‌ناحیه‌ای در استان فعلی آماده کنید. جست‌وجوی شبکهٔ سراسری متوقف است.',
        pilot_completed: 'آزمایش این ناحیه تمام شده است. تعداد پاسخ‌های POI را بررسی کنید؛ شبکهٔ سراسری به‌صورت خودکار ادامه نمی‌یابد.',
        pilot_review_required: 'آزمایش ناموفق یا نامطمئن است. تاریخچه را بررسی کنید و در صورت نیاز موارد حل‌نشده را به صف بازگردانید.',
        authorization_required: 'گردآوری تا تکمیل NDA و تأیید مجوز استفادهٔ داخلی متوقف است. نمایش اطلاعات POI روی نقشه مجاز نیست.',
        storage_cleanup_required: 'اطلاعات قدیمی Nearby هنوز در پایگاه داده وجود دارد. پیش از ادامه، فرمان پاک‌سازی را با پردازشگر متوقف اجرا کنید.',
        missing_service_key: 'کلید سرویس نشان هنوز تنظیم نشده است؛ گردآوری قابل شروع نیست. پس از فعال‌سازی دسترسی، NESHAN_SERVICE_API_KEY را روی سرور تنظیم کنید.',
        no_active_job: 'برنامهٔ فعالی وجود ندارد. برای آماده‌سازی، بخش «ساخت برنامهٔ سراسری جدید» را باز کنید. ساخت برنامه به نشان درخواستی نمی‌فرستد.',
        worker_not_running: 'پردازشگر گردآوری اجرا نشده یا ارتباط آن قطع است. برای ادامه، ابتدا پردازشگر جداگانه را روی سرور اجرا کنید.'
    };
    function updateControls() {
        if($('poi-source-attach')) {
            $('poi-source-attach').disabled=actionBusy || !lastStatus?.job || !lastStatus.paused || !!lastStatus.in_flight || !!lastStatus.job.search_dataset_version || !$('poi-source-select').value;
            $('poi-settlement-enable').disabled=actionBusy || !lastStatus?.job?.search_dataset_version || !lastStatus.paused || !!lastStatus.in_flight || lastStatus.pilot?.status!=='complete' || !lastStatus.pilot?.details_saved;
        }
        $('poi-pause').disabled = actionBusy || !lastStatus || !lastStatus.can_pause;
        $('poi-resume').disabled = actionBusy || !lastStatus || !lastStatus.can_resume;
        $('poi-retry').disabled = actionBusy || !lastStatus || !lastStatus.job || !!lastStatus.in_flight;
        $('poi-pilot-prepare').disabled = actionBusy || !lastStatus || !lastStatus.job || !lastStatus.paused || !!lastStatus.in_flight || (lastStatus.pilot && lastStatus.pilot.status==='processing') || (!!lastStatus.job.search_dataset_version && !$('poi-settlement-select')?.value);
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
        const pilot=data.pilot;
        if($('poi-source-select')) {
            const sources=data.search_sources || [], key=sources.map(s=>s.version).join(',');
            if(key!==sourceKey) {
                $('poi-source-select').replaceChildren();
                sources.forEach(source=>{const o=document.createElement('option');o.value=source.version;o.textContent=`${num(source.summary.ready)} نقطهٔ آماده / ${num(source.summary.review)} نیازمند بررسی · ${source.version.slice(0,12)}`;$('poi-source-select').append(o);});
                sourceKey=key;
            }
            const attached=job?.search_dataset_version, source=sources.find(s=>s.version===attached) || sources[0];
            $('poi-source-summary').textContent=source ? `${attached?'متصل به برنامه':'هنوز متصل نشده'} · ${num(source.summary.ready)} آماده · ${num(source.summary.review)} نیازمند بررسی: ${(source.summary.review_points || []).map(p=>p.name).join('،')}` : 'ابتدا فرمان واردسازی فایل‌ها را روی سرور اجرا کنید.';
        }
        $('poi-pilot-status').textContent=pilot ? `آزمایش ${num(pilot.id)} · ${pilot.province} · ${titles[pilot.category] || pilot.category} · مبدأ: ${pilot.latitude}, ${pilot.longitude} · شعاع: ${num(pilot.radius_m)} متر · وضعیت: ${labels[pilot.status] || pilot.status} · پاسخ جزئیات ذخیره‌شده: ${num(pilot.details_saved)}` : 'هنوز مبدأیی برای آزمایش انتخاب نشده است. مختصات حدسی وارد نکنید.';
        const pilotSlugs=(job && job.categories) || [];
        const nextPilotKey=jobId+':'+pilotSlugs.join(',');
        if(nextPilotKey!==pilotCategoriesKey) {
            const select=$('poi-pilot-category'),previous=select.value;
            select.replaceChildren();
            pilotSlugs.forEach(slug=>{const option=document.createElement('option');option.value=slug;option.textContent=titles[slug] || slug;select.append(option);});
            select.value=pilotSlugs.includes(previous)?previous:(pilotSlugs[0] || '');
            pilotCategoriesKey=nextPilotKey;
        }

        $('poi-readiness').textContent = readinessMessages[data.resume_blocked_reason] || (data.paused ? 'گردآوری متوقف است؛ برای ادامه از دکمهٔ «ادامهٔ گردآوری» استفاده کنید.' : 'گردآوری برای پردازش برنامهٔ فعال آماده است.');
        $('poi-worker').textContent = 'وضعیت: ' + (labels[data.state] || data.state) + ' · پردازشگر: ' + (data.worker_alive ? 'متصل' : 'قطع / اجرا نشده');
        $('poi-timing').textContent = 'آخرین ضربان: ' + time(data.heartbeat_at) + ' · زودترین درخواست بعدی: ' + time(data.next_request_at);
        const reasonLabels = {'Search sources attached; prepare one settlement pilot first':'مجموعه متصل شد؛ ابتدا آزمایش یک نقطه را آماده کنید.',
            'Settlement buffers enabled; collection remains paused until explicit resume':'برنامهٔ نقاط آماده است و هنوز متوقف است؛ برای اجرا دکمهٔ ادامه را بزنید.',
            'Search sources available; review the search scope before resuming':'پیش از ادامه، مجموعه و محدودهٔ جست‌وجو را بررسی کنید.','Single-area pilot prepared; resume explicitly to run it':'آزمایش آماده است و هنوز درخواستی ارسال نشده است. مختصات را بررسی و سپس ادامه را انتخاب کنید.',
            'Single-area pilot finished; nationwide grid remains paused':'پردازش این ناحیه پایان یافت. شبکهٔ سراسری همچنان متوقف است.',
            'Choose a single-area pilot before continuing; nationwide grid is paused':'ابتدا آزمایش تک‌ناحیه‌ای را آماده کنید؛ شبکهٔ سراسری متوقف است.',
            'Pilot has no dispatchable work; review its result before continuing':'آزمایش درخواست جدیدی برای ارسال ندارد؛ نتیجهٔ آن را بررسی کنید.','Nearby produced no new usable hashes; review area/category with Neshan before continuing':'Nearby هش جدیدی برای دریافت جزئیات برنگرداند. برای جلوگیری از درخواست‌های انبوه بدون POI، گردآوری متوقف شد؛ ناحیه و لایه را با نشان بررسی کنید.','No worker or job yet':'هنوز پردازشگر یا برنامه‌ای ثبت نشده است.', 'Paused by administrator':'گردآوری با درخواست مدیر متوقف شده است.', 'New job ready; resume to begin':'برنامهٔ جدید آماده است؛ پس از آماده‌شدن کلید و پردازشگر می‌توانید گردآوری را ادامه دهید.', 'NESHAN_SERVICE_API_KEY is not configured':'کلید سرویس نشان تنظیم نشده است.'};
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
        card('جست‌وجوی بدون نتیجه',num(job && job.empty_searches));
        const areas = job ? job.areas : [], grouped = new Map();
        areas.forEach(row => { const entry = grouped.get(row.province) || {complete:0,pending:0,failed:0,uncertain:0}; entry[row.status] = (entry[row.status] || 0)+row.count; grouped.set(row.province,entry); });
        const complete = areas.filter(r=>r.status==='complete').reduce((sum,r)=>sum+r.count,0);
        const totalAreas = areas.reduce((sum,r)=>sum+r.count,0);
        $('poi-coverage').textContent = job ? `${labels[job.status] || job.status} · استان‌های تمام‌شده: ${num(job.completed_provinces)} · باقی‌مانده: ${num(job.remaining_provinces)} · برنامه‌ریزی‌شده: ${num(job.planned_provinces)} از ۳۱ · جست‌وجوهای تمام‌شده: ${num(complete)} از ${num(totalAreas)} ناحیه / دستهٔ برنامه‌ریزی‌شده · نواحی علامت‌گذاری‌شده برای بررسی: ${num(job.flagged_segments)} · جزئیات در صف: ${num(job.details.pending)} · جزئیات ناموفق / نامطمئن: ${num((job.details.failed || 0)+(job.details.uncertain || 0))}` : 'هنوز برنامه‌ای ساخته نشده است.';
        if(data.job?.search_dataset_version)$('poi-coverage').textContent += ' · '+data.coverage_label;
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
                if($('poi-settlement-select') && lastStatus.job?.search_dataset_version) {
                    const points=await adminFetch('/api/admin/poi/settlements'), key=points.map(p=>p.id).join(',');
                    if(key!==pointKey) {
                        const selected=$('poi-settlement-select').value;
                        sourcePoints=points;$('poi-settlement-select').replaceChildren();
                        points.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name+' · '+p.province+' · '+(p.county || '');$('poi-settlement-select').append(o);});
                        if(points.some(p=>p.id===selected))$('poi-settlement-select').value=selected;
                        pointKey=key;fillSettlement();
                        $('poi-pilot-radius').value=lastStatus.job.radius_m;
                    }
                }
                updateControls();
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
    $('poi-pilot-form').onsubmit = event => {
        event.preventDefault();
        if(lastStatus?.job?.search_dataset_version) {
            action($('poi-pilot-prepare'),'/api/admin/poi/settlement-pilot',{
                settlement_id:$('poi-settlement-select').value,category:$('poi-pilot-category').value,radius_m:Number($('poi-pilot-radius').value)
            });return;
        }
        action($('poi-pilot-prepare'),'/api/admin/poi/pilot',{
            latitude:Number($('poi-pilot-lat').value),longitude:Number($('poi-pilot-lon').value),
            category:$('poi-pilot-category').value,radius_m:Number($('poi-pilot-radius').value)
        });
    };
    function fillSettlement() {
        const point=sourcePoints.find(p=>p.id===$('poi-settlement-select').value);
        if(point){$('poi-pilot-lat').value=point.latitude;$('poi-pilot-lon').value=point.longitude;}
        const attached=!!lastStatus?.job?.search_dataset_version;
        $('poi-pilot-lat').readOnly=attached;$('poi-pilot-lon').readOnly=attached;
    }
    if($('poi-source-attach')) {
        $('poi-source-attach').onclick=()=>action($('poi-source-attach'),'/api/admin/poi/search-sources',{version:$('poi-source-select').value});
        $('poi-settlement-select').onchange=()=>{fillSettlement();updateControls();};
        $('poi-settlement-enable').onclick=()=>action($('poi-settlement-enable'),'/api/admin/poi/settlement-plan');
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
            requests.forEach(row=>{const li=document.createElement('li');const button=document.createElement('button');button.type='button';button.textContent=`${row.id} · ${row.kind} · ${labels[row.outcome] || row.outcome} · ${row.http_status || '—'} · نتایج: ${row.result_count ?? '—'} · هش: ${row.hash_count ?? '—'} · در صف جزئیات: ${row.queued_count ?? '—'} · ${time(row.started_at)}`;button.onclick=async()=>{try{$('poi-raw').textContent=JSON.stringify(await adminFetch('/api/admin/poi/requests/'+row.id),null,2);}catch(err){error(err);}};li.append(button);$('poi-history').append(li);});
            $('poi-reviews').replaceChildren();reviews.forEach(row=>{const li=document.createElement('li');li.textContent=row.place_id+' / '+row.other_place_id+' · '+row.reason;$('poi-reviews').append(li);});
        } catch(err) { error(err); }
    };
    // Polling is read-only and stops while this view or browser tab is hidden.
    setInterval(()=>{if (!document.hidden && !$('view-poi').hidden) load();},5000);
    updateControls();
    window.AdminPoi = {load};
})();
