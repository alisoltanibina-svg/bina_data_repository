// Manual reports; the managed worker runs independently of this page.
(() => {
    const $ = id => document.getElementById(id);
    const labels={not_configured:'پیکربندی نشده',idle:'بدون برنامهٔ فعال',running:'در حال اجرا',waiting:'در انتظار',pausing:'در حال توقف',paused:'متوقف',interrupted:'ارتباط پردازشگر قطع شده',pending:'در صف',completed:'برنامه پایان یافته',needs_review:'نیازمند بررسی',successful:'موفق',failed:'ناموفق',uncertain:'نامطمئن',dispatched:'ارسال‌شده',complete:'پایان‌یافته',processing:'دریافت جزئیات',cancelled:'جایگزین شده'};
    const titles={mosque:'مسجد',formal_school:'مدرسه',school:'مؤسسهٔ آموزشی',library:'کتابخانه',park:'بوستان',hospital:'بیمارستان',cinema:'سینما',theater:'تئاتر',university:'دانشگاه'};
    const num=n=>Number(n || 0).toLocaleString('fa-IR');
    const time=t=>t?new Date(t).toLocaleString('fa-IR',{timeZone:'Asia/Tehran'}):'—';
    const provinceLabel=name=>name==='Unassigned source points'?'بدون انتساب به مرزهای موجود':name;
    const pct=n=>n==null?'—':num(n)+'٪';
    const reasonLabels={
        'Polygon plan prepared; complete offline coverage verification before starting':'برنامهٔ چندضلعی ساخته شده است؛ تأیید هندسی کامل باید پیش از شروع پایان یابد.',
        'Polygon plan verified; provider result limit required':'پوشش هندسی کامل تأیید شده است؛ سقف نتایج Nearby هنوز باید از نشان دریافت و ثبت شود.',
        'Polygon plan verified; resume explicitly to begin':'پوشش هندسی کامل تأیید شده است؛ برای اجرا شروع گردآوری را بزنید.',
        'Polygon plan requires completed coverage verification and a confirmed provider result limit':'تأیید هندسی کامل و ثبت سقف نتایج نشان پیش از اجرا لازم است.',
        'Provider result limit still reached at minimum radius; coverage requires review':'حتی در کمترین شعاع، پاسخ به سقف نتایج رسیده است؛ ناحیه هنوز کامل نیست و نیاز به بررسی دارد.','Collection plan finished':'جست‌وجوهای برنامه پایان یافته‌اند؛ سرویس پردازشگر روشن می‌ماند.',
            'Collection plan finished; review flagged results':'جست‌وجوها پایان یافته‌اند؛ موارد علامت‌گذاری‌شده را بررسی کنید.',
            'Search sources attached; prepare one settlement pilot first':'مجموعه متصل شد؛ ابتدا آزمایش یک نقطه را آماده کنید.',
            'Settlement buffers enabled; collection remains paused until explicit resume':'برنامهٔ نقاط آماده است و هنوز متوقف است؛ برای اجرا دکمهٔ ادامه را بزنید.',
            'Search sources available; review the search scope before resuming':'پیش از ادامه، مجموعه و محدودهٔ جست‌وجو را بررسی کنید.','Single-area pilot prepared; resume explicitly to run it':'آزمایش آماده است و هنوز درخواستی ارسال نشده است. مختصات را بررسی و سپس ادامه را انتخاب کنید.',
            'Single-area pilot finished; nationwide grid remains paused':'بررسی اتصال پایان یافت؛ برای فعال‌سازی برنامه، شروع گردآوری خودکار را بزنید.',
            'Choose a single-area pilot before continuing; nationwide grid is paused':'ابتدا بررسی اولیهٔ اتصال را از تنظیمات این بخش آماده کنید.',
            'Pilot has no dispatchable work; review its result before continuing':'آزمایش درخواست جدیدی برای ارسال ندارد؛ نتیجهٔ آن را بررسی کنید.','Nearby produced no new usable hashes; review area/category with Neshan before continuing':'بررسی اتصال هش جدیدی نداشت. سرویس روشن است؛ یک نقطهٔ دیگر برای بررسی اتصال انتخاب کنید.','No worker or job yet':'هنوز پردازشگر یا برنامه‌ای ثبت نشده است.', 'Paused by administrator':'گردآوری با درخواست مدیر متوقف شده است.', 'New job ready; resume to begin':'برنامهٔ جدید آماده است؛ پس از آماده‌شدن کلید و پردازشگر می‌توانید گردآوری را ادامه دهید.', 'NESHAN_SERVICE_API_KEY is not configured':'کلید سرویس نشان تنظیم نشده است.'};
    const readinessMessages={
        coverage_algorithm_mismatch:'نسخهٔ الگوریتم پوشش تغییر کرده است؛ برنامه باید بازسازی و تأیید شود.',
        coverage_not_ready:'برنامهٔ پوشش چندضلعی‌ها در حال ساخت و تأیید هندسی است؛ پس از پایان آماده می‌شود.',
        coverage_limit_required:'سقف نتایج Nearby باید از نشان تأیید و روی برنامه ثبت شود تا تقسیم خودکار نواحی پرتراکم قابل اعتماد باشد.',
        unresolved_work:'ابتدا درخواست‌های ناموفق یا نامطمئن محدودهٔ فعلی را در تاریخچه بررسی کنید.',
        worker_outdated:'پردازشگر نسخهٔ قدیمی را اجرا می‌کند؛ سرویس گردآوری را بازراه‌اندازی کنید.',
        pilot_required:'برای فعال‌سازی برنامه ابتدا بررسی اتصال را آماده و اجرا کنید.',
        pilot_completed:'بررسی اتصال پایان یافته است؛ اگر جزئیات با موفقیت ذخیره شده، دکمهٔ اصلی گردآوری برنامه را فعال می‌کند.',
        pilot_review_required:'بررسی اتصال ناموفق یا نامطمئن است؛ ابتدا تاریخچه را بررسی کنید.',
        authorization_required:'تنظیم مجوز NDA و استفادهٔ داخلی کامل نشده است.',
        storage_cleanup_required:'پاک‌سازی بررسی‌شدهٔ داده‌های قدیمی Nearby پیش از ادامه لازم است.',
        missing_service_key:'کلید NESHAN_SERVICE_API_KEY روی سرور تنظیم نشده است.',
        no_active_job:'برای شروع، یک برنامه و مجموعهٔ جغرافیایی در تنظیمات ثبت کنید.',
        worker_not_running:'سرویس پردازشگر متصل نیست؛ وضعیت poi-worker.service را روی سرور بررسی کنید.'
    };
    let lastStatus=null,loadPromise=null,actionBusy=false,layersLoaded=false,sourceKey='',pointKey='',categoryKey='',jobId='',points=[];
    const isActive=()=>lastStatus?.job && ['pending','running'].includes(lastStatus.job.status);
    function updateControls(){
        const d=lastStatus,j=d?.job,attached=!!j?.search_dataset_version;
        $('poi-resume').disabled=actionBusy || !attached || !(d?.can_start_collection || d?.can_resume);
        $('poi-resume').textContent=d?.collection_mode==='pilot' && d?.can_resume?'اجرای بررسی اتصال':'شروع / ادامهٔ گردآوری خودکار';
        $('poi-resume').title=readinessMessages[d?.resume_blocked_reason] || '';
        $('poi-pause').disabled=actionBusy || !d?.can_pause;
        $('poi-refresh').disabled=actionBusy;
        $('poi-retry').disabled=actionBusy || !j || !d?.paused || !!d?.in_flight;
        $('poi-source-attach').disabled=actionBusy || !isActive() || !d.paused || !!d.in_flight || attached || !$('poi-source-select').value;
        $('poi-pilot-prepare').disabled=actionBusy || !isActive() || !attached || !d.paused || !!d.in_flight || d.pilot?.status==='processing' || !$('poi-settlement-select').value;
        $('poi-create-submit').disabled=actionBusy || !!isActive();
    }
    function error(e){$('poi-error').hidden=false;$('poi-error').textContent=e.message || 'دریافت گزارش ممکن نشد.';}
    function options(id,rows,value,label){
        const select=$(id),selected=select.value;select.replaceChildren();
        rows.forEach(row=>{const o=document.createElement('option');o.value=value(row);o.textContent=label(row);select.append(o);});
        if(rows.some(r=>value(r)===selected))select.value=selected;
    }
    function card(title,value){
        const article=document.createElement('article');article.className='admin-ops-card';
        const h=document.createElement('h3');h.textContent=title;
        const p=document.createElement('p');p.className='admin-stat-value';p.textContent=value;article.append(h,p);$('poi-summary').append(article);
    }
    function render(d){
        lastStatus=d;const job=d.job,pilot=d.pilot,g=d.geography;jobId=job?.id || '';
        $('poi-report-time').textContent='آخرین گزارش: '+time(d.reported_at || new Date().toISOString())+' · تازه‌سازی دستی';
        $('poi-worker').textContent='وضعیت گردآوری: '+(labels[d.state] || d.state)+' · سرویس پردازشگر: '+(d.worker_alive?'متصل':'قطع / اجرا نشده');
        $('poi-timing').textContent='آخرین ضربان: '+time(d.heartbeat_at)+' · زودترین درخواست بعدی: '+time(d.next_request_at);
        $('poi-reason').textContent=reasonLabels[d.reason] || d.reason || '';
        $('poi-readiness').textContent=d.can_start_collection?'گردآوری خودکار آماده است. شروع، نقاط و استان‌های مجموعه را به ترتیب پردازش می‌کند.':
            readinessMessages[d.resume_blocked_reason] || (d.paused?'گردآوری متوقف است؛ سرویس پردازشگر برای ادامه آماده می‌ماند.':'گردآوری خودکار فعال است؛ برای دیدن وضعیت جدید، گزارش را تازه‌سازی کنید.');
        const sources=d.search_sources || [],key=sources.map(r=>r.version).join(',');
        if(key!==sourceKey){
            const legacySources=sources.filter(r=>!r.summary.algorithm?.startsWith('full-polygon-and-point'));
            ['poi-source-select','poi-create-source'].forEach(id=>options(id,legacySources,r=>r.version,r=>num(r.summary.ready)+' نقطهٔ آماده · '+r.version.slice(0,12)));
            sourceKey=key;
        }
        const source=sources.find(r=>r.version===job?.search_dataset_version);
        $('poi-source-summary').textContent=source?`${num(source.summary.ready)} نقطهٔ آماده · ${num(source.summary.review)} نیازمند بررسی: ${(source.summary.review_points || []).map(p=>p.name).join('،')}`:
            'مجموعهٔ جغرافیایی به برنامه متصل نشده است. تنظیمات را باز کنید.';
        if(source?.summary.point_warnings){const warnings=source.summary.point_warnings;$('poi-source-summary').textContent=`${num(source.summary.ready)} نقطهٔ مشمول جست‌وجوی ۳ کیلومتری · ${num(warnings.outside_or_ambiguous_province)} نقطه خارج از مرزهای ارائه‌شده · ${num(warnings.name_requires_review)} نام نیازمند بازبینی. پرچم‌های کیفیت در دادهٔ خروجی حفظ شده‌اند.`;}
        $('poi-attach-panel').hidden=!isActive() || !!job?.search_dataset_version;
        const hasPolygonSources=sources.some(r=>r.summary.algorithm?.startsWith('full-polygon-and-point'));
        $('poi-create').hidden=!!isActive() || hasPolygonSources;
        $('poi-full-plan-help').hidden=!hasPolygonSources;
        $('poi-full-plan-help').textContent=d.geography?.plan_id?`طرح پوشش: ${d.geography.plan_id} · ${d.geography.pending_tiles} کاشی باقی‌مانده برای تأیید. ساخت و ادامهٔ ساخت از برنامه‌ساز آفلاین انجام می‌شود؛ دکمهٔ شروع پس از تأیید هندسه و ثبت سقف نتایج فعال می‌شود.`:'برای این مجموعه، برنامهٔ پوشش چندضلعی را با برنامه‌ساز آفلاین آماده کنید؛ برنامهٔ نقطه‌ای قدیمی پوشش مساحتی ایجاد نمی‌کند.';
        $('poi-job-config').textContent=job?`برنامه ${job.id} · شعاع ${num(job.radius_m)} متر · دسته‌ها: ${(job.categories || []).map(c=>titles[c] || c).join('،')} · ${labels[job.status] || job.status}`:'هنوز برنامه‌ای وجود ندارد.';
        if(g?.scope==='verified_polygon_union_and_3km_points')$('poi-job-config').textContent += ` · شعاع نقاط ${num(g.point_radius_m)} متر · شعاع چندضلعی‌ها ${num(g.polygon_radius_m)} متر`;
        if(!job?.search_dataset_version)$('poi-setup').open=true;
        $('poi-verification').hidden=!isActive() || !job.search_dataset_version || d.collection_mode!=='pilot' || !!d.can_start_collection;
        $('poi-pilot-status').textContent=pilot?`بررسی ${num(pilot.id)} · ${pilot.province} · ${labels[pilot.status] || pilot.status} · پاسخ جزئیات موفق: ${num(pilot.details_saved)}`:'هنوز بررسی اتصال آماده نشده است.';
        const categories=job?.categories || [],catKey=jobId+':'+categories.join(',');
        if(catKey!==categoryKey){options('poi-pilot-category',categories,r=>r,r=>titles[r] || r);categoryKey=catKey;}
        $('poi-summary').replaceChildren();
        const requests=job?.requests || [];
        for(const kind of ['nearby','details'])card(kind==='nearby'?'درخواست Nearby':'درخواست جزئیات POI',num(requests.filter(r=>r.kind===kind).reduce((n,r)=>n+r.count,0)));
        card('مکان یکتای ذخیره‌شده',num(d.unique_saved));
        card('هش تکراری؛ درخواست جلوگیری‌شده',num(job?.duplicates_skipped));
        card('درخواست ناموفق / نامطمئن',num(requests.filter(r=>['failed','uncertain'].includes(r.outcome)).reduce((n,r)=>n+r.count,0)));
        card('جزئیات منتظر در حافظه',num(job?.details?.pending));
        card('نتیجهٔ فاقد هش قابل استفاده',num(job?.missing_hashes));
        const polygonPlan=g?.scope==='verified_polygon_union_and_3km_points';
        $('poi-progress').value=polygonPlan?(g.area_percent || 0):(g?.percent || 0);
        $('poi-progress-label').textContent=g?`${pct(g.percent)} · ${num(g.completed_searches)} از ${num(g.expected_searches)} جست‌وجو · ${num(g.completed_points)} از ${num(g.total_points)} نقطه تمام شده · ${num(g.empty_searches)} جست‌وجو بدون هش جدید · ${num(g.excluded_points)} نقطه خارج از اجرا`:'پیشرفت پس از اتصال مجموعه نمایش داده می‌شود.';
        if(polygonPlan)$('poi-progress-label').textContent=`پوشش مساحتی انجام‌شده: ${pct(g.area_percent)} · ${num(g.completed_area_m2/1e6)} از ${num(g.metric_area_m2/1e6)} کیلومتر مربع · جست‌وجوهای ۳ کیلومتری نقاط: ${num(g.completed_point_searches)} از ${num(g.expected_point_searches)} · ${num(g.pending_tiles)} کاشی منتظر تأیید · سقف نتایج: ${g.result_limit?num(g.result_limit):'تأیید نشده'}`;
        $('poi-coverage').textContent=g?`استان فعلی: ${provinceLabel(g.current_province) || 'نقاط برنامه پایان یافته‌اند'} · گروه‌های جغرافیایی تمام‌شده: ${num(g.provinces.filter(r=>r.complete).length)} از ${num(g.provinces.length)}`:'سوابق شبکهٔ قبلی در پیشرفت مجموعه محاسبه نمی‌شوند.';
        $('poi-areas').replaceChildren();
        (g?.provinces || []).forEach(r=>{
            const tr=document.createElement('tr');
            [provinceLabel(r.province),pct(r.percent),polygonPlan?num(r.completed_area_m2/1e6)+' / '+num(r.area_m2/1e6)+' km²':num(r.completed_points)+' / '+num(r.total_points),num(r.completed_searches)+' / '+num(r.expected_searches),num(r.pending_searches),num(r.empty_searches),num(r.review_searches)].forEach((value,index)=>{const td=document.createElement('td');if(polygonPlan && index===2)td.dir='ltr';td.textContent=value;tr.append(td);});
            $('poi-areas').append(tr);
        });
        $('poi-categories').replaceChildren();
        (d.categories || []).forEach(r=>{const li=document.createElement('li');li.textContent=(titles[r.category] || r.category)+': '+num(r.unique_saved);$('poi-categories').append(li);});
        updateControls();
    }
    function fillPoint(){const p=points.find(r=>r.id===$('poi-settlement-select').value);$('poi-point-coordinates').textContent=p?`${p.latitude}, ${p.longitude}`:'';}
    function load(){
        if(loadPromise)return loadPromise;
        loadPromise=(async()=>{
            try{
                $('poi-error').hidden=true;render(await adminFetch('/api/admin/poi/status'));
                if(!$('poi-verification').hidden){
                    const rows=await adminFetch('/api/admin/poi/settlements'),key=rows.map(r=>r.id).join(',');
                    if(key!==pointKey){points=rows;options('poi-settlement-select',rows,r=>r.id,r=>r.name+' · '+r.province+' · '+(r.county || ''));pointKey=key;fillPoint();}
                }
                if(!layersLoaded){
                    const layers=await adminFetch('/api/admin/poi/categories');options('poi-layers',layers,r=>r,r=>titles[r] || r);
                    Array.from($('poi-layers').options || []).forEach(o=>o.selected=['mosque','formal_school','library','park','hospital'].includes(o.value));layersLoaded=true;
                }
                updateControls();
            }catch(e){error(e);}finally{loadPromise=null;}
        })();return loadPromise;
    }
    async function action(button,path,body){
        if(actionBusy)return;actionBusy=true;button.disabled=true;updateControls();
        try{
            await adminFetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body || {})});
            if(loadPromise)await loadPromise;await load();
        }catch(e){error(e);}finally{actionBusy=false;button.disabled=false;updateControls();}
    }
    $('poi-resume').onclick=()=>action($('poi-resume'),lastStatus?.collection_mode==='pilot' && lastStatus?.can_resume?'/api/admin/poi/resume':'/api/admin/poi/start');
    $('poi-pause').onclick=()=>action($('poi-pause'),'/api/admin/poi/pause');
    $('poi-refresh').onclick=load;
    $('poi-source-attach').onclick=()=>action($('poi-source-attach'),'/api/admin/poi/search-sources',{version:$('poi-source-select').value});
    $('poi-settlement-select').onchange=()=>{fillPoint();updateControls();};
    $('poi-pilot-form').onsubmit=event=>{event.preventDefault();action($('poi-pilot-prepare'),'/api/admin/poi/settlement-pilot',{
        settlement_id:$('poi-settlement-select').value,category:$('poi-pilot-category').value,radius_m:lastStatus.job.radius_m
    });};
    $('poi-mode').onchange=()=>{const refresh=$('poi-mode').value==='refresh';$('poi-cutoff-wrap').hidden=!refresh;$('poi-cutoff').required=refresh;};
    $('poi-create').onsubmit=event=>{
        event.preventDefault();const body={categories:Array.from($('poi-layers').selectedOptions,o=>o.value),radius_m:Number($('poi-radius').value),
            mode:$('poi-mode').value,search_dataset_version:$('poi-create-source').value};
        if(body.mode==='refresh')body.refresh_before=new Date($('poi-cutoff').value).toISOString();
        action($('poi-create-submit'),'/api/admin/poi/jobs',body);
    };
    $('poi-retry').onclick=()=>{if(jobId && window.confirm('موارد ناموفق و نامطمئن محدودهٔ فعلی، پس از بررسی، به صف بازگردند؟'))action($('poi-retry'),'/api/admin/poi/jobs/'+encodeURIComponent(jobId)+'/retry-unresolved');};
    $('poi-history-load').onclick=async()=>{
        try{
            const [requests,reviews]=await Promise.all([adminFetch('/api/admin/poi/requests'+(jobId?'?job_id='+encodeURIComponent(jobId):'')),adminFetch('/api/admin/poi/duplicate-reviews')]);
            $('poi-history').replaceChildren();$('poi-raw').textContent='';
            requests.forEach(r=>{const li=document.createElement('li'),b=document.createElement('button');b.type='button';
                b.textContent=`${r.id} · ناحیه ${num(r.target_id)} · ${r.kind} · ${labels[r.outcome] || r.outcome} · HTTP ${r.http_status || '—'} · نتایج ${r.result_count ?? '—'} · هش ${r.hash_count ?? '—'} · ${time(r.started_at)}`;
                b.onclick=async()=>{try{$('poi-raw').textContent=JSON.stringify(await adminFetch('/api/admin/poi/requests/'+r.id),null,2);}catch(e){error(e);}};li.append(b);$('poi-history').append(li);
            });
            $('poi-reviews').replaceChildren();reviews.forEach(r=>{const li=document.createElement('li');li.textContent=r.place_id+' / '+r.other_place_id+' · '+r.reason;$('poi-reviews').append(li);});
        }catch(e){error(e);}
    };
    // No timer, background polling, or visibility-triggered requests.
    updateControls();window.AdminPoi={load};
})();
