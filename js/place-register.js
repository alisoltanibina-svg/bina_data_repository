// One account-owned draft spans every registration stage and survives page reloads.
onReady(async()=>{
    const {api,node,normalize,provinceAllowed}=PlaceUI,el=id=>document.getElementById(id),form=el('place-registration-form');
    const params=new URLSearchParams(window.location.search),venue=params.get('venue'),inputs=new Map();
    const stageIds=['place-stage-1','place-stage-2','place-stage-3','place-registration-form'];
    let config,draft,data,step=1,changed=0,saved=0,timer,saveTask,busy=false,closed=false,pointValid=false,conflict=false,polling=false;
    const message=(text,error=false)=>{el('place-form-status').textContent=text;el('place-form-status').classList.toggle('is-error',error);};
    const saveStatus=text=>el('place-draft-status').textContent=text;
    const photo=PlacePhotoPicker({onChange:()=>touch()});
    const map=PlaceRegistrationMap({onPoint(point){Object.assign(data,point);pointValid=false;touch();controls();},
        onValidity(value){pointValid=value;controls();},onZoom(zoom){if(data&&data.zoom!==zoom){data.zoom=zoom;touch(false);}}});
    function pointExists(){return Number.isFinite(data?.latitude)&&Number.isFinite(data?.longitude);}
    function typeAllowed(){return !!data?.category&&config.editable_categories.includes(data.category)&&config.categories.some(row=>row.category===data.category);}
    function provinceReady(){return typeAllowed()&&provinceAllowed(config,data.province,data.category);}
    function controls(){
        if(!data)return;
        for(const button of document.querySelectorAll('[data-step]')){
            const target=Number(button.dataset.step);button.disabled=busy||(target>1&&!typeAllowed())||(target>2&&!provinceReady())||(target>3&&!pointExists());
            if(target===step)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');
        }
        el('place-previous').disabled=busy||step===1;el('place-next').hidden=step===4;el('place-submit').hidden=step!==4;
        el('place-next').disabled=busy||(step===1&&!typeAllowed())||(step===2&&!provinceReady())||(step===3&&!pointValid);
        el('place-submit').disabled=busy||!provinceReady()||!pointValid||draft?.status==='pending';
        el('place-cancel-request').disabled=busy;form.inert=busy;
        el('place-context').textContent=[config.categories.find(c=>c.category===data.category)?.title,data.province].filter(Boolean).join(' · ');
        const pending=draft?.status==='pending',rejected=draft?.status==='rejected',notice=el('place-request-status');
        notice.hidden=!pending&&!rejected;
        el('place-new-request').hidden=!pending;
        el('place-request-message').textContent=pending?'درخواست شما در انتظار بررسی است. با تغییر اطلاعات، درخواست قبلی از بررسی خارج می‌شود؛ پس از تکمیل، دوباره ارسال کنید.':
            rejected?'درخواست تأیید نشده است. اطلاعات را اصلاح و دوباره ارسال کنید.':'';
    }
    function touch(content=true){
        if(!draft||closed)return;
        if(content)data.submission_id=crypto.randomUUID();
        changed++;saveStatus('در حال ذخیره…');el('place-save-retry').hidden=true;clearTimeout(timer);
        timer=setTimeout(()=>persist().catch(()=>{}),600);
    }
    function readForm(){
        data.values={name:el('place-name').value,address:el('place-address').value,phoneNumber:el('place-phone').value,website:el('place-website').value};
        for(const [key,{input,field}] of inputs)data.attributes[key]=input.value===''?null:field.kind==='boolean'?input.value==='true':field.kind==='number'?Number(input.value):input.value;
    }
    function renderFields(){
        inputs.clear();el('place-attribute-fields').replaceChildren();
        for(const field of PlaceUI.definitions(config,data.province)){
            const label=node('label',field.label);let input;
            if(field.kind==='boolean'||field.kind==='choice'){
                input=node('select');const blank=node('option','نامشخص');blank.value='';input.append(blank);
                for(const [value,title] of field.kind==='boolean'?[['true','بله'],['false','خیر']]:field.choices.map(v=>[v,v])){
                    const option=node('option',title);option.value=value;input.append(option);
                }
            }else{
                input=node('input');input.type=field.kind==='number'?'number':'text';const rules=field.constraints||{};
                if(input.type==='number'){input.step=rules.integer?'1':'any';if(rules.minimum!=null)input.min=rules.minimum;if(rules.maximum!=null)input.max=rules.maximum;}
                else input.maxLength=rules.max_length||2000;
            }
            input.value=data.attributes[field.key]==null?'':String(data.attributes[field.key]);input.required=field.required;
            label.append(input);el('place-attribute-fields').append(label);inputs.set(field.key,{input,field});
        }
    }
    function renderTypes(){
        el('place-types').replaceChildren();
        for(const category of config.categories){
            const button=node('button',null,'place-wizard-type');button.type='button';button.disabled=!config.editable_categories.includes(category.category);
            const icon=node('img');icon.src=PlaceUI.categoryIcon(category);icon.alt='';button.append(icon,node('span',category.title));
            button.classList.toggle('is-selected',data.category===category.category);button.setAttribute('aria-pressed',String(data.category===category.category));
            button.addEventListener('click',()=>{
                if(data.category===category.category)return;
                data.category=category.category;data.province=null;data.latitude=data.longitude=null;pointValid=false;
                renderTypes();renderProvinces();touch();controls();
            });el('place-types').append(button);
        }
    }
    function renderProvinces(){
        const select=el('place-province'),rows=config.coverage.provinces.filter(row=>provinceAllowed(config,row.province,data.category||'mosque'));
        const blank=node('option',rows.length?'استان را انتخاب کنید':'استان فعالی وجود ندارد');blank.value='';select.replaceChildren(blank);
        for(const row of rows){const option=node('option',row.province);option.value=row.province;select.append(option);}
        select.disabled=!rows.length;select.value=rows.find(row=>normalize(row.province)===normalize(data.province))?.province||'';
        el('place-province-hint').textContent=rows.length?'فقط استان‌هایی که ثبت مکان در آن‌ها فعال است نمایش داده می‌شوند.':'در حال حاضر استانی برای ثبت مکان فعال نیست. پیش‌نویس شما محفوظ می‌ماند.';
    }
    function updateMetadata(result){draft={...result};data.base_version=result.data.base_version;data.source_version=result.data.source_version;controls();}
    function sameContent(a,b){
        const content=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!['zoom','submission_id','base_version','source_version'].includes(key)));
        const stable=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?
            Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
        return stable(content(a))===stable(content(b));
    }
    async function persist(keepalive=false){
        clearTimeout(timer);
        if(closed||!draft||changed===saved)return;
        if(saveTask){await saveTask;if(changed!==saved)return persist(keepalive);return;}
        if(conflict)throw new Error('پیش‌نویس در صفحهٔ دیگری تغییر کرده است؛ نسخهٔ ذخیره‌شده را دریافت کنید.');
        saveTask=(async()=>{
            saveStatus('در حال ذخیره…');el('place-save-retry').hidden=true;
            try{
                while(changed!==saved&&!closed){
                    const attachment=await photo.upload(data);
                    data.photo_id=attachment.photo_id||null;data.remove_photo=attachment.remove_photo===true;
                    const snapshot=changed,body={version:draft.version,step,data:structuredClone(data)};
                    const result=await api('/api/poi-explore/registration-drafts/'+draft.id,{method:'PUT',keepalive,body:JSON.stringify(body)});
                    updateMetadata(result);saved=snapshot;saveStatus('ذخیره شد');
                }
            }catch(error){
                conflict=error.status===409;saveStatus(error.message);el('place-save-retry').textContent=conflict?'دریافت نسخهٔ ذخیره‌شده':'تلاش دوباره';el('place-save-retry').hidden=false;throw error;
            }finally{saveTask=null;}
        })();
        return saveTask;
    }
    async function validatePoint(){
        pointValid=false;controls();if(!pointExists()||!provinceReady())return false;
        const candidate={category:data.category,latitude:data.latitude,longitude:data.longitude};
        try{
            const result=await api('/api/poi-explore/editor/eligibility?'+new URLSearchParams(candidate));
            if(candidate.latitude!==data.latitude||candidate.longitude!==data.longitude)return false;
            pointValid=!!result.eligible&&normalize(result.province)===normalize(data.province);
            if(!pointValid)message(result.reason||'نقطه باید در استان انتخاب‌شده باشد.',true);
        }catch(error){message(error.message,true);}
        controls();return pointValid;
    }
    function displayStage(target,focus=true){
        step=target;
        stageIds.forEach((id,index)=>el(id).hidden=index+1!==step);
        map.hide();controls();
        if(step===3)map.show(data,config.categories,draft.place_id);
        if(focus)el(['place-type-title','place-province-title','place-point-title','place-details-title'][step-1]).focus();
    }
    async function go(target){
        if(busy||closed||target===step)return;
        if(target>1&&!typeAllowed()||target>2&&!provinceReady()){message('ابتدا نوع مکان و استان فعال را انتخاب کنید.',true);return;}
        busy=true;controls();saveStatus('در حال ذخیره…');
        try{
            await persist();
            if(target===4&&!await validatePoint())return;
            displayStage(target);touch(false);await persist();message('');
        }catch(error){message(error.message,true);}
        finally{busy=false;controls();}
    }
    function finish(status){
        closed=true;clearTimeout(timer);map.hide();el('place-wizard').hidden=true;el('place-success').hidden=false;message('');
        el('place-success-title').textContent=status==='approved'?'اطلاعات مکان تأیید شد':'درخواست لغو شد';
        el('place-success-message').textContent=status==='approved'?'اطلاعات تأییدشده روی نقشه نمایش داده می‌شود.':'این پیش‌نویس بسته شد و برای بررسی ارسال نخواهد شد.';
        el('place-success-title').focus();
    }
    async function poll(){
        if(polling||closed||busy||saveTask||changed!==saved||document.hidden||!draft)return;polling=true;
        try{
            const result=await api('/api/poi-explore/registration-drafts/'+draft.id);
            if(busy||saveTask||changed!==saved)return;
            if(['approved','cancelled'].includes(result.status)){finish(result.status);return;}
            if(result.version!==draft.version){
                if(!sameContent(result.data,draft.data)){conflict=true;saveStatus('پیش‌نویس در صفحهٔ دیگری تغییر کرده است.');el('place-save-retry').hidden=false;el('place-save-retry').textContent='دریافت نسخهٔ ذخیره‌شده';}
                else {data.submission_id=result.data.submission_id;updateMetadata(result);}
            }
        }catch{/* The saved draft remains available; retry on the next poll. */}
        finally{polling=false;}
    }
    try{
        config=await api('/api/poi-explore/editor/config');if(!config.permissions.can_edit)throw new Error('برای ثبت مکان، وارد حساب کاربری شوید.');
        const requested=params.get('draft');
        draft=requested?await api('/api/poi-explore/registration-drafts/'+encodeURIComponent(requested)):params.get('new')==='1'?null:
            (await api('/api/poi-explore/registration-drafts/current'+(venue?'?place_id='+encodeURIComponent(venue):''))).draft;
        if(!draft)draft=await api('/api/poi-explore/registration-drafts',{method:'POST',body:JSON.stringify({place_id:venue||null,start_new:params.get('new')==='1'})});
        data=structuredClone(draft.data);step=draft.step;
        const url=new URL(window.location.href);url.search='';url.searchParams.set('draft',draft.id);history.replaceState(null,'',url);
        if(['approved','cancelled'].includes(draft.status)){finish(draft.status);return;}
        // Import a pre-upgrade handoff once, then keep the server draft authoritative.
        const legacy=PlaceUI.readRegistration(venue||null);
        if(legacy&&draft.version===0&&!requested){
            Object.assign(data,{category:legacy.category,province:legacy.province,latitude:legacy.latitude,longitude:legacy.longitude,zoom:legacy.zoom||16});
            if(legacy.form){Object.assign(data.values,legacy.form.values);data.attributes=legacy.form.attributes||{};
                data.photo_id=legacy.form.photo?.photo_id||null;data.remove_photo=legacy.form.photo?.remove_photo===true;}
            step=4;touch();
        }
        el('place-form-title').textContent=draft.place_id?'ویرایش مکان':'افزودن مکان';
        for(const [key,id] of [['name','place-name'],['address','place-address'],['phoneNumber','place-phone'],['website','place-website']])el(id).value=data.values[key]||'';
        photo.restore(data);renderFields();renderTypes();renderProvinces();el('place-wizard').hidden=false;
        if(!typeAllowed())step=1;else if(!provinceReady())step=Math.min(step,2);else if(!pointExists())step=Math.min(step,3);
        displayStage(params.get('step')==='3'&&provinceReady()?3:step,false);message('');saveStatus('ذخیره شد');
        if(pointExists())await validatePoint();await persist();sessionStorage.removeItem('place-registration');
    }catch(error){message(error.message,true);return;}
    for(const button of document.querySelectorAll('[data-step]'))button.addEventListener('click',()=>go(Number(button.dataset.step)));
    el('place-next').addEventListener('click',()=>go(Math.min(4,step+1)));
    el('place-previous').addEventListener('click',()=>go(Math.max(1,step-1)));
    el('place-change-position').addEventListener('click',()=>go(3));
    el('place-province').addEventListener('change',()=>{
        const name=el('place-province').value||null;if(normalize(name)===normalize(data.province))return;
        data.province=name;data.latitude=data.longitude=null;data.attributes.province=name;pointValid=false;
        renderFields();touch();controls();
    });
    form.addEventListener('input',event=>{if(event.target.id==='place-photo-file')return;readForm();touch();controls();});
    el('place-map-reset').addEventListener('click',map.reset);
    el('place-map-retry').addEventListener('click',()=>map.show(data,config.categories,draft.place_id));
    el('place-save-retry').addEventListener('click',()=>{
        if(conflict){if(window.confirm('نسخهٔ ذخیره‌شده جایگزین تغییرات ذخیره‌نشدهٔ این صفحه شود؟'))window.location.reload();}
        else persist().catch(()=>{});
    });
    el('place-cancel-request').addEventListener('click',async()=>{
        if(busy||!window.confirm('درخواست و پیش‌نویس آن لغو شود؟'))return;busy=true;controls();
        try{
            clearTimeout(timer);
            // Cancellation discards unsaved input; a failed photo upload must
            // not prevent the user from cancelling the saved request.
            if(saveTask)try{await saveTask;}catch{/* DELETE still checks the saved draft version. */}
            await api('/api/poi-explore/registration-drafts/'+draft.id,{method:'DELETE',body:JSON.stringify({version:draft.version})});
            finish('cancelled');
        }catch(error){message(error.message,true);}
        finally{busy=false;controls();}
    });
    form.addEventListener('submit',async event=>{
        event.preventDefault();if(busy||closed||draft.status==='pending'||!form.reportValidity())return;busy=true;controls();
        try{
            readForm();await persist();if(!await validatePoint())return;
            const body={draft_id:draft.id,draft_version:draft.version,submission_id:data.submission_id,version:data.base_version,source_version:data.source_version,
                values:{...data.values,name:data.values.name.trim(),category:data.category,latitude:data.latitude,longitude:data.longitude},
                attributes:{...data.attributes,province:data.province},reason:draft.place_id?'به‌روزرسانی اطلاعات مسجد از فرم ثبت':'ثبت مسجد از فرم اطلاعات مکانی',
                photo_id:data.photo_id,remove_photo:data.remove_photo};
            const result=await api('/api/poi-explore/manual-places'+(draft.place_id?'/'+encodeURIComponent(draft.place_id):''),{method:draft.place_id?'PATCH':'POST',body:JSON.stringify(body)});
            updateMetadata(result.draft);photo.committed();saveStatus('ذخیره شد');message('درخواست برای بررسی ارسال شد.');controls();
        }catch(error){message(error.message,true);}
        finally{busy=false;controls();}
    });
    window.addEventListener('beforeunload',event=>{if(!closed&&(busy||changed!==saved||saveTask)){event.preventDefault();event.returnValue='';}});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)persist(true).catch(()=>{});else poll();});
    const pollTimer=setInterval(poll,20000);window.addEventListener('pagehide',()=>{clearInterval(pollTimer);clearTimeout(timer);});
});
