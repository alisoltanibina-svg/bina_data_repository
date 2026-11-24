// Published venue corrections and province-gated editorial revisions.
function LocationEditor({map,categories,canEdit,onModeChange,onSaved,getScene,onOverlayChange,onSelectCategory}) {
    const el=id=>document.getElementById(id);
    const node=(tag,text,className)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(className)n.className=className;return n;};
    const button=(text,run)=>{const n=node('button',text);n.type='button';n.addEventListener('click',run);return n;};
    const number=new Intl.NumberFormat('fa-IR');
    const common=['name','category','latitude','longitude','address','phoneNumber','website'];
    const fields={};common.forEach(key=>{fields[key]=el(`locations-place-${key}`);});
    let editing=false,dirty=false,saving=false,picking=false,record=null,selected=null,submission=crypto.randomUUID();
    let config={permissions:{can_edit:canEdit},coverage:{provinces:[]},fields:[]};
    let timer=null,controller=null,generation=0,draftMarker=null,listLayer=L.layerGroup().addTo(map),lastKey='';
    let published=[],suppressed=new Set(),attributes={},hoursValue=null,socialValue=null,hoursDirty=false,socialDirty=false;
    let pointTimer=null,pointRequest=0,targetAllowed=false;
    let detailRequest=0,reviewRequest=0;
    let viewCategoryBeforeEdit=null;
    const attributeInputs=new Map();
    const feedback=(text,error=false)=>{el('locations-editor-feedback').textContent=text;el('locations-editor-feedback').classList.toggle('is-error',error);};
    async function api(path,options={}) {
        const response=await fetch(`${window.API_BASE_URL||''}${path}`,{credentials:'include',cache:'no-store',...options,
            headers:{'Content-Type':'application/json','X-CSRF-Protection':'1',...(options.headers||{})}});
        const data=await response.json();
        if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:'انجام درخواست ممکن نشد.');
        return data;
    }
    function discard(){return !dirty||window.confirm('تغییرات ذخیره نشده‌اند. از آن‌ها صرف‌نظر می‌کنید؟');}
    function changed(){dirty=true;submission=crypto.randomUUID();}
    function checkPoint(){
        clearTimeout(pointTimer);const request=++pointRequest;if(!editing)return;
        targetAllowed=false;el('locations-save-place').disabled=true;
        el('locations-new-place').disabled=true;
        pointTimer=setTimeout(async()=>{const center=map.getCenter();const latitude=fields.latitude.value?Number(fields.latitude.value):center.lat;
            const longitude=fields.longitude.value?Number(fields.longitude.value):center.lng;
            if(!Number.isFinite(latitude)||!Number.isFinite(longitude))return;
            try{const data=await api('/api/poi-explore/editor/eligibility?'+new URLSearchParams({category:fields.category.value,latitude,longitude}));
                if(request!==pointRequest)return;targetAllowed=data.eligible;
                const province=attributeInputs.get('province');if(province&&data.province){province.input.value=data.province;attributes.province=data.province;updateCounties(data.province);}
                el('locations-target-eligibility').textContent=data.eligible?`${data.province} · ثبت و ویرایش فعال است`:data.reason;
                el('locations-save-place').disabled=saving||!targetAllowed||!!record&&!record.can_edit;
                el('locations-new-place').disabled=saving||!targetAllowed;
            }catch(error){if(request===pointRequest)el('locations-target-eligibility').textContent=error.message;}
        },300);
    }
    function pick(on){picking=on;document.body.classList.toggle('is-picking',on);el('locations-pick-point').setAttribute('aria-pressed',String(on));
        el('locations-pick-point').textContent=on?'نقطهٔ مورد نظر را روی نقشه بزنید':'انتخاب نقطه روی نقشه';}
    function draft(){
        if(draftMarker){draftMarker.remove();draftMarker=null;}
        const lat=Number(fields.latitude.value),lon=Number(fields.longitude.value);
        if(!editing||!fields.latitude.value||!fields.longitude.value||!Number.isFinite(lat)||!Number.isFinite(lon)||lat<24||lat>41||lon<43||lon>64)return;
        const category=categories.find(c=>c.category===fields.category.value)||selected;
        draftMarker=L.marker([lat,lon],{icon:L.icon({iconUrl:category?.icon_url,iconSize:[36,36],iconAnchor:[18,18],
            className:'locations-live-icon locations-manual-icon'}),title:'نقطهٔ پیشنهادی'}).addTo(map);
    }
    function renderAttributes(){
        const root=el('locations-extra-fields');root.replaceChildren();attributeInputs.clear();
        for(const definition of config.fields.filter(f=>f.active&&f.categories.includes(fields.category.value))){
            const label=node('label',definition.label+(definition.required?' *':''));
            let input;
            if(definition.kind==='choice'||definition.kind==='boolean'){
                input=node('select');const blank=node('option','نامشخص');blank.value='';input.append(blank);
                const options=definition.kind==='boolean'?[['true','بله'],['false','خیر']]:definition.choices.map(v=>[v,v]);
                options.forEach(([value,title])=>{const option=node('option',title);option.value=value;input.append(option);});
            }else{input=node('input');input.type=definition.kind==='number'?'number':definition.kind==='date'?'date':'text';
                const rules=definition.constraints||{};if(input.type==='number'){input.step=rules.integer?'1':'any';if(rules.minimum!=null)input.min=String(rules.minimum);if(rules.maximum!=null)input.max=String(rules.maximum);}
                input.maxLength=rules.max_length||2000;if(rules.coordinate_province)input.readOnly=true;}
            input.value=attributes[definition.key]==null?'':String(attributes[definition.key]);input.required=definition.required;
            input.addEventListener('input',changed);label.append(input);
            if(definition.constraints?.county_suggestions){input.setAttribute('list','locations-county-suggestions');const list=node('datalist');list.id='locations-county-suggestions';label.append(list);}
            root.append(label);attributeInputs.set(definition.key,{input,definition});
        }
        updateCounties(attributes.province);
        root.hidden=!root.childElementCount;
    }
    function updateCounties(province){
        const list=document.getElementById('locations-county-suggestions');if(!list)return;list.replaceChildren();
        for(const county of config.administrative_areas?.[province]||[]){const option=node('option',county);option.value=county;list.append(option);}
    }
    function rangeRow(root,value={}){
        const row=node('div',null,'locations-hours-range');
        const start=node('input');start.type='time';start.required=true;start.value=value.start||'';start.setAttribute('aria-label','از ساعت');
        const end=node('input');end.type='time';end.required=true;end.value=value.end||'';end.setAttribute('aria-label','تا ساعت');
        row.append(start,end,button('حذف',()=>{row.remove();hoursDirty=true;changed();}));
        start.addEventListener('input',()=>{hoursDirty=true;changed();});end.addEventListener('input',()=>{hoursDirty=true;changed();});root.append(row);
    }
    function renderHours(value){
        hoursValue=value;hoursDirty=false;const root=el('locations-hours-fields');root.replaceChildren();
        for(const day of ['شنبه','یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه','پنجشنبه','جمعه']){
            const existing=(Array.isArray(value)?value:[]).find(v=>String(v.day).replace(/[\s\u200c]/g,'')===day.replace(/[\s\u200c]/g,''));
            const row=node('div',null,'locations-hours-day');row.dataset.day=day;
            const select=node('select');select.setAttribute('aria-label',day);
            [['unknown','نامشخص'],['closed','تعطیل'],['open','باز']].forEach(([value,title])=>{const o=node('option',title);o.value=value;select.append(o);});
            select.value=!existing?'unknown':existing.ranges?.length?'open':'closed';
            const ranges=node('div',null,'locations-hours-ranges');const add=button('بازهٔ دیگر +',()=>{if(ranges.children.length<8){rangeRow(ranges);hoursDirty=true;changed();}});
            const sync=()=>{ranges.hidden=select.value!=='open';add.hidden=select.value!=='open';
                ranges.querySelectorAll('input').forEach(i=>{i.disabled=select.value!=='open';});};
            select.addEventListener('change',()=>{if(select.value==='open'&&!ranges.children.length)rangeRow(ranges);sync();hoursDirty=true;changed();});
            row.append(node('span',day),select,ranges,add);root.append(row);
            (existing?.ranges||[]).forEach(r=>rangeRow(ranges,r));sync();
        }
    }
    function socialRow(value={}){
        const row=node('div',null,'locations-social-row');row._original=typeof value==='object'&&value?{...value}:{};
        row._labelKey=['label','title','name','network'].find(k=>typeof row._original[k]==='string')||'label';
        row._urlKey=['url','link','website','address'].find(k=>typeof row._original[k]==='string')||'url';
        const title=node('input');title.placeholder='نام شبکه';title.maxLength=100;title.value=row._original[row._labelKey]||'';
        const url=node('input');url.placeholder='نشانی';url.dir='ltr';url.maxLength=800;url.value=typeof value==='string'?value:row._original[row._urlKey]||'';
        [title,url].forEach(i=>i.addEventListener('input',()=>{socialDirty=true;changed();}));
        row.append(title,url,button('حذف',()=>{row.remove();socialDirty=true;changed();}));el('locations-social-fields').append(row);
    }
    function renderSocial(value){socialValue=value;socialDirty=false;el('locations-social-fields').replaceChildren();(Array.isArray(value)?value:[]).forEach(socialRow);}
    function readExtras(){
        let workHours=hoursValue,socialNetworks=socialValue;
        if(hoursDirty){workHours=[];for(const row of el('locations-hours-fields').children){const mode=row.querySelector('select').value;if(mode==='unknown')continue;
            const ranges=mode==='closed'?[]:[...row.querySelectorAll('.locations-hours-range')].map(r=>{const inputs=r.querySelectorAll('input');return {start:inputs[0].value,end:inputs[1].value};});
            if(mode==='open'&&!ranges.length)throw new Error('برای روز باز، حداقل یک بازهٔ ساعت وارد کنید.');workHours.push({day:row.dataset.day,ranges});}if(!workHours.length)workHours=null;}
        if(socialDirty)socialNetworks=[...el('locations-social-fields').children].map(row=>{const inputs=row.querySelectorAll('input');return {...row._original,[row._labelKey]:inputs[0].value.trim(),[row._urlKey]:inputs[1].value.trim()};});
        const attrs=fields.category.value===record?.values.category?{...attributes}:{};
        for(const [key,{input,definition}] of attributeInputs){attrs[key]=input.value===''?null:definition.kind==='number'?Number(input.value):definition.kind==='boolean'?input.value==='true':input.value;}
        return {workHours,socialNetworks,attributes:attrs};
    }
    function fill(data=null){
        record=data;attributes={...(data?.attributes||{})};const values=data?.values||{};
        const allowed=config.editable_categories;
        const defaultCategory=allowed?.length?(allowed.includes(selected?.category)?selected.category:allowed[0]):selected?.category||categories[0]?.category||'';
        common.forEach(key=>{fields[key].value=values[key]??(key==='category'?defaultCategory:'');});
        renderHours(values.workHours??null);renderSocial(values.socialNetworks??null);renderAttributes();
        el('locations-change-reason').value='';dirty=false;submission=crypto.randomUUID();pick(false);draft();feedback('');
        el('locations-editor-title').textContent=data?'ویرایش مکان':'ثبت مکان';
        el('locations-save-place').textContent='ارسال برای بررسی';el('locations-use-source').hidden=!data?.source;
        el('locations-history').replaceChildren();
        el('locations-save-place').disabled=!!data&&!data.can_edit;
        if(data?.locked_reason)feedback(data.locked_reason,true);
        if(data?.pending_revision)feedback('پیشنهاد در انتظار بررسی'+(data.pending_actor?.name?' · '+data.pending_actor.name:''));
        checkPoint();
    }
    async function configure(){
        config=await api('/api/poi-explore/editor/config');canEdit=config.permissions.can_edit;
        el('locations-mode-switch').hidden=!canEdit;el('locations-review-wrap').hidden=!config.permissions.can_review;
        el('locations-admin-tools').hidden=!config.permissions.can_manage;
        const root=el('locations-eligible-provinces');root.replaceChildren();
        const allowed=config.coverage.provinces.filter(p=>config.permissions.all_provinces||config.permissions.provinces.includes(p.province));
        allowed.forEach(p=>root.append(node('li',`${p.province}: ${number.format(p.completed_searches)} / ${number.format(p.expected_searches)} · ${p.eligible?'فعال':'بسته'}`)));
        const editable=config.editable_categories||[];
        [...fields.category.options].forEach(option=>{option.disabled=!editable.includes(option.value);});
        if(!record&&!editable.includes(fields.category.value))fields.category.value=editable[0]||'';
        el('locations-new-place').disabled=!canEdit||!editable.length||!targetAllowed;
        el('locations-province-note').textContent=allowed.some(p=>p.eligible)?'ثبت و ویرایش فعلاً فقط برای مسجد و در استان‌های فعال مجاز است.':'هنوز استانی برای ثبت و ویرایش آماده نیست.';
        if(!dirty)renderAttributes();
    }
    async function setMode(mode){
        if(!canEdit||saving||(mode!=='edit'&&!discard()))return;
        try{if(mode==='edit')await configure();if(!canEdit)return;
            if(mode!=='edit')++detailRequest;
            if(mode==='edit'&&!editing)viewCategoryBeforeEdit=selected?.category||null;
            editing=mode==='edit';document.body.classList.toggle('is-editing',editing);el('locations-editor').hidden=!editing;
            el('locations-view-mode').setAttribute('aria-pressed',String(!editing));el('locations-edit-mode').setAttribute('aria-pressed',String(editing));
            if(!editing)fill();onModeChange(editing);
            if(editing&&onSelectCategory&&!(config.editable_categories||[]).includes(selected?.category)&&config.editable_categories?.length)await onSelectCategory(config.editable_categories[0]);
            if(!editing&&onSelectCategory&&viewCategoryBeforeEdit&&selected?.category!==viewCategoryBeforeEdit)await onSelectCategory(viewCategoryBeforeEdit);
            if(!editing)viewCategoryBeforeEdit=null;
            map.invalidateSize();lastKey='';schedule();checkPoint();
        }catch(error){feedback(error.message,true);}
    }
    function safeLink(value){
        if(typeof value!=='string'||!value.trim())return null;
        let text=value.trim();if(!/^[a-z][a-z0-9+.-]*:/i.test(text))text='https://'+text;
        try{const u=new URL(text);return ['http:','https:'].includes(u.protocol)&&u.hostname&&!u.username&&!u.password?u.href:null;}catch{return null;}
    }
    function valueText(key,value){
        if(value==null||value==='')return 'نامشخص';
        if(key==='workHours'&&Array.isArray(value))return value.map(r=>`${r.day}: ${(r.ranges||[]).length?r.ranges.map(t=>`${t.start} تا ${t.end}`).join('، '):'تعطیل'}`).join('\n');
        if(Array.isArray(value))return value.map(v=>typeof v==='object'?Object.values(v).join(' · '):String(v)).join('\n');
        return typeof value==='boolean'?(value?'بله':'خیر'):String(value);
    }
    const titles={name:'نام',category:'نوع مکان',latitude:'عرض جغرافیایی',longitude:'طول جغرافیایی',address:'نشانی',phoneNumber:'تلفن',website:'وبسایت',workHours:'ساعات فعالیت',socialNetworks:'شبکه‌های اجتماعی'};
    function showDetails(data){
        const root=el('locations-detail-body');root.replaceChildren();el('locations-detail-title').textContent=data.values.name;
        for(const [key,title] of Object.entries(titles)){const value=data.values[key];const term=node('dt',title),description=node('dd');
            const url=key==='website'?safeLink(value):null;
            if(url){const a=node('a',String(value));a.href=url;a.target='_blank';a.rel='noopener noreferrer';description.append(a);}
            else description.textContent=key==='category'?(categories.find(c=>c.category===value)?.title||valueText(key,value)):valueText(key,value);
            root.append(term,description);}
        for(const [key,value] of Object.entries(data.attributes||{})){root.append(node('dt',config.fields.find(f=>f.key===key)?.label||key),node('dd',valueText(key,value)));}
        el('locations-detail-status').textContent=data.tag==='added'?'افزوده‌شده در سامانه':data.tag==='edited'?'ویرایش‌شده در سامانه':'اطلاعات ثبت‌شدهٔ نشان';
        const authors=data.contributors;
        if(authors){const creator=authors.created_by?.name,editor=authors.last_edited_by?.name;
            root.append(node('dt',data.tag==='added'?'ثبت‌کننده':'ویرایش‌کننده'),node('dd',(data.tag==='added'?creator:editor)||'ثبت‌کننده مشخص نیست'));
            if(data.tag==='added'&&editor&&editor!==creator)root.append(node('dt','آخرین ویرایش‌کننده'),node('dd',editor));}
        el('locations-detail-edit').hidden=!canEdit;el('locations-detail-edit').disabled=!data.can_edit;
        el('locations-detail-lock').textContent=data.locked_reason||'';el('locations-detail').hidden=false;
        el('locations-detail-edit').onclick=()=>open(data.id);
    }
    async function inspect(place){
        const request=++detailRequest;
        try{const path=place.localId?`/api/poi-explore/venues/${encodeURIComponent(place.localId)}`:place.id?`/api/poi-explore/venue-match/${encodeURIComponent(place.id)}`:null;
            if(!path)throw new Error('برای این مکان شناسهٔ قابل تطبیق در دسترس نیست.');
            const position=!place.localId&&Number.isFinite(place.latitude)&&Number.isFinite(place.longitude)?
                '?'+new URLSearchParams({latitude:place.latitude,longitude:place.longitude}):'';
            const data=await api(path+position);if(request===detailRequest)showDetails(data);
        }catch(error){if(request!==detailRequest)return;el('locations-detail').hidden=false;el('locations-detail-title').textContent=place.name||'اطلاعات مکان';el('locations-detail-body').replaceChildren();
            el('locations-detail-lock').textContent=error.message;el('locations-detail-status').textContent='';el('locations-detail-edit').hidden=true;}
    }
    async function open(id){
        const request=++detailRequest;
        if(!canEdit){
            try{const data=await api(`/api/poi-explore/venues/${encodeURIComponent(id)}`);if(request!==detailRequest)return;showDetails(data);
                if(onSelectCategory)await onSelectCategory(data.values.category);map.setView([data.values.latitude,data.values.longitude],15);
            }catch(error){el('locations-detail').hidden=false;el('locations-detail-lock').textContent=error.message;}
            return;
        }
        if(saving||!discard())return;
        try{const data=await api(`/api/poi-explore/venues/${encodeURIComponent(id)}?draft=true`);if(request!==detailRequest)return;
            if(!data.can_edit){showDetails(data);return;}
            if(!editing)await setMode('edit');if(!editing||request!==detailRequest)return;
            fill(data);el('locations-detail').hidden=true;
            if(onSelectCategory&&selected?.category!==data.values.category)await onSelectCategory(data.values.category);
            map.setView([data.values.latitude,data.values.longitude],Math.max(15,map.getZoom()));fields.name.focus();
            await history();
        }catch(error){feedback(error.message,true);}
    }
    async function history(page=0){
        if(!record)return;const root=el('locations-history');if(page===0)root.replaceChildren();
        const placeId=record.id;const data=await api(`/api/poi-explore/venues/${placeId}/history?page=${page}`);if(record?.id!==placeId)return;
        data.revisions.forEach(r=>{const row=node('div',null,'locations-revision-row');row.append(node('span',`نسخهٔ ${number.format(r.version)} · ${statusTitle(r.status)} · ${r.actor_name||'کاربر '+(r.actor_id??'—')}`));
            row.append(node('p',r.reason));if(record.can_edit)row.append(button('پیشنهاد بازیابی این نسخه',async()=>{if(saving||!discard())return;
                const reason=window.prompt('دلیل بازیابی این نسخه را بنویسید:');if(!reason)return;
                try{await api(`/api/poi-explore/venues/${record.id}/restore`,{method:'POST',body:JSON.stringify({submission_id:crypto.randomUUID(),version:record.version,revision_id:r.id,reason})});await open(record.id);feedback('پیشنهاد بازیابی برای بررسی ارسال شد.');}catch(error){feedback(error.message,true);}}));root.append(row);});
        (data.source_history||[]).forEach(snapshot=>{const section=node('details');section.append(node('summary','نسخهٔ پیشین منبع · '+(snapshot.observed_at?new Date(snapshot.observed_at).toLocaleDateString('fa-IR',{timeZone:'Asia/Tehran'}):'')));
            const dl=node('dl');for(const [key,label] of Object.entries(titles))dl.append(node('dt',label),node('dd',valueText(key,snapshot.values[key])));section.append(dl);root.append(section);});
        if(data.has_more){const more=button('سوابق قدیمی‌تر',async()=>{more.disabled=true;try{await history(page+1);more.remove();}catch(error){more.disabled=false;feedback(error.message,true);}});root.append(more);}
    }
    function statusTitle(status){return {pending:'در انتظار بررسی',approved:'تأییدشده',rejected:'ردشده'}[status]||status;}
    async function reviews(){
        const request=++reviewRequest;const root=el('locations-review-list');root.replaceChildren();
        try{const data=await api('/api/poi-explore/editor/revisions');if(request!==reviewRequest)return;if(!data.revisions.length)root.append(node('p','پیشنهادی در انتظار بررسی نیست.'));
            data.revisions.forEach(r=>{const card=node('article',null,'locations-review-card');card.append(node('h3',r.after.name),node('p',`${r.actor_name||'کاربر '+(r.actor_id??'—')} · ${r.reason}`));
                card.append(button('دیدن محدوده روی نقشه',async()=>{if(onSelectCategory)await onSelectCategory(r.after.category);map.setView([r.after.latitude,r.after.longitude],16);}));
                const dl=node('dl');for(const key of Object.keys(titles)){if(r.action==='added'||JSON.stringify(r.before[key])!==JSON.stringify(r.after[key]))dl.append(node('dt',titles[key]),node('dd',r.action==='added'?valueText(key,r.after[key]):`${valueText(key,r.before[key])} ← ${valueText(key,r.after[key])}`));}
                for(const [key,value] of Object.entries(r.attributes||{}))dl.append(node('dt',config.fields.find(f=>f.key===key)?.label||key),node('dd',valueText(key,value)));
                const note=node('textarea');note.placeholder='یادداشت بررسی';note.maxLength=1000;const actions=node('div',null,'locations-editor-actions');
                const review=async approve=>{try{await api(`/api/poi-explore/editor/revisions/${r.id}/review`,{method:'POST',body:JSON.stringify({approve,note:note.value})});lastKey='';await reviews();schedule();await onSaved({});}catch(error){feedback(error.message,true);}};
                actions.append(button('تأیید و انتشار',()=>review(true)),button('رد پیشنهاد',()=>review(false)));card.append(dl,note,actions);root.append(card);});
        }catch(error){root.append(node('p',error.message));}
    }
    async function refresh(){
        if(controller)controller.abort();const version=++generation;
        if(!selected||document.hidden)return;
        const scene=getScene();const bounds=scene.bounds;const plan=scene.plan;
        if(scene.zoom<8||!plan){published=[];suppressed.clear();listLayer.clearLayers();onOverlayChange();return;}
        const identities=[...new Set(scene.records.map(r=>r.place.id).filter(id=>/^[a-f0-9]{64}$/.test(id||'')))];
        const key=JSON.stringify([selected.category,bounds,plan,identities,editing,Math.floor(Date.now()/30000)]);
        if(lastKey===key)return;controller=new AbortController();
        try{
            const rows=new Map(),hidden=new Set();let hasMore=false;
            // Prefixes fit a full memory viewport in one bounded request. The server
            // returns full identities, so a prefix collision cannot hide another place.
            const prefixes=[...new Set(identities.map(id=>id.slice(0,8)))];
            const batches=Math.max(1,Math.ceil(prefixes.length/5000));
            for(let offset=0;offset<batches;offset++){
                const data=await api('/api/poi-explore/overlays',{method:'POST',signal:controller.signal,
                    body:JSON.stringify({category:selected.category,...bounds,latitude:plan.latitude,longitude:plan.longitude,radius:plan.radius,
                        zoom:Math.floor(scene.zoom),prefixes:prefixes.slice(offset*5000,(offset+1)*5000),include_places:offset===0})});
                data.places.forEach(row=>rows.set(row.id,row));data.suppressed.forEach(id=>hidden.add(id));hasMore ||= data.has_more;
            }
            if(version!==generation)return;published=[...rows.values()];suppressed=hidden;lastKey=key;onOverlayChange();
            el('locations-overlay-note').hidden=!hasMore;
            if(editing){
                const query=new URLSearchParams({category:selected.category,...bounds});const data=await api(`/api/poi-explore/editor/places?${query}`,{signal:controller.signal});
                if(version!==generation)return;const root=el('locations-manual-list');root.replaceChildren();listLayer.clearLayers();
                data.places.forEach(row=>{root.append(button(row.name,()=>open(row.id)));
                    if(row.tag||published.some(place=>place.id===row.id)||scene.records.some(record=>record.place.id===row.identity))return;
                    const marker=L.marker([row.latitude,row.longitude],{
                    icon:L.icon({iconUrl:selected.icon_url,iconSize:[24,24],iconAnchor:[12,12],className:'locations-live-icon locations-database-icon'}),title:row.name});
                    marker.on('click',()=>inspect({localId:row.id,name:row.name})).addTo(listLayer);});
                el('locations-manual-status').textContent=data.has_more?'۲۰۰ مکان نمایش داده شد؛ نقشه را بزرگ‌تر کنید.':`${number.format(data.places.length)} مکان در پایگاه داده`;
            }else listLayer.clearLayers();
        }catch(error){if(error.name!=='AbortError'&&version===generation){el('locations-manual-status').textContent=error.message;lastKey='';}}
    }
    function schedule(category=selected){
        if(selected?.category!==category?.category){published=[];suppressed.clear();lastKey='';listLayer.clearLayers();}
        selected=category;if(controller)controller.abort();++generation;clearTimeout(timer);timer=setTimeout(refresh,250);
        if(editing&&!record&&!fields.latitude.value)checkPoint();
    }
    function merge(records,bounds,zoom){
        const output=records.filter(r=>!suppressed.has(r.place.id));
        if(zoom<8)return output;
        const plan=getScene().plan;if(!plan)return output;
        for(const place of published){
            if(place.latitude<bounds.south||place.latitude>bounds.north||place.longitude<bounds.west||place.longitude>bounds.east||
                LocationDiscovery.distance(place,plan)>plan.radius)continue;
            output.push({key:`local/${place.id}/${place.published_version||0}`,category:place.category,place:{...place,localId:place.id,id:place.identity||undefined}});
        }
        return output;
    }
    for(const category of categories){const option=node('option',category.title);option.value=category.category;fields.category.append(option);}
    common.forEach(key=>fields[key].addEventListener('input',()=>{changed();if(key==='category'){attributes={};renderAttributes();}if(['category','latitude','longitude'].includes(key)){draft();checkPoint();}}));
    el('locations-mode-switch').hidden=!canEdit;
    el('locations-view-mode').addEventListener('click',()=>setMode('view'));el('locations-edit-mode').addEventListener('click',()=>setMode('edit'));
    el('locations-new-place').addEventListener('click',()=>{if(!saving&&discard()){++detailRequest;fill();}});el('locations-cancel-place').addEventListener('click',()=>{if(!saving&&discard()){++detailRequest;fill();}});
    el('locations-refresh-places').addEventListener('click',()=>{lastKey='';schedule();});el('locations-refresh-reviews').addEventListener('click',reviews);
    el('locations-detail-close').addEventListener('click',()=>{++detailRequest;el('locations-detail').hidden=true;});
    el('locations-add-social').addEventListener('click',()=>{if(el('locations-social-fields').children.length<20){socialRow();socialDirty=true;changed();}});
    el('locations-pick-point').addEventListener('click',()=>{if(!saving)pick(!picking);});
    el('locations-use-source').addEventListener('click',()=>{if(!saving&&record?.source){const data={...record,values:record.source};fill(data);changed();feedback('مقادیر منبع انتخاب شدند؛ برای ثبت، دلیل تغییر را بنویسید.');}});
    map.on('click',event=>{if(!editing||!picking||saving)return;fields.latitude.value=event.latlng.lat.toFixed(6);fields.longitude.value=event.latlng.lng.toFixed(6);changed();pick(false);draft();checkPoint();});
    window.addEventListener('beforeunload',event=>{if(dirty||saving){event.preventDefault();event.returnValue='';}});
    window.addEventListener('pagehide',()=>{clearTimeout(timer);clearTimeout(pointTimer);if(controller)controller.abort();});
    el('locations-place-form').addEventListener('submit',async event=>{
        event.preventDefault();if(!canEdit||!editing||saving||!targetAllowed||!el('locations-place-form').reportValidity())return;
        let body;try{const extras=readExtras();const values={...record?.values};common.forEach(key=>{values[key]=['latitude','longitude'].includes(key)?Number(fields[key].value):fields[key].value.trim()||null;});
            values.workHours=extras.workHours;values.socialNetworks=extras.socialNetworks;
            if(record?.source&&!hoursDirty&&JSON.stringify(hoursValue)===JSON.stringify(record.source.workHours))delete values.workHours;
            if(record?.source&&!socialDirty&&JSON.stringify(socialValue)===JSON.stringify(record.source.socialNetworks))delete values.socialNetworks;
            body={submission_id:submission,version:record?.version||0,source_version:record?.source_version||null,values,attributes:extras.attributes,reason:el('locations-change-reason').value.trim()};
        }catch(error){feedback(error.message,true);return;}
        saving=true;el('locations-save-place').disabled=true;feedback('در حال ارسال…');
        const controls=el('locations-place-form').querySelectorAll('input,select,textarea,button');controls.forEach(n=>{n.disabled=true;});
        try{const saved=await api(`/api/poi-explore/manual-places${record?'/'+encodeURIComponent(record.id):''}`,{method:record?'PATCH':'POST',body:JSON.stringify(body)});
            dirty=false;await onSaved(saved);const data=await api(`/api/poi-explore/venues/${saved.id}?draft=true`);fill(data);feedback('پیشنهاد برای بررسی ارسال شد.');await history();lastKey='';schedule();
        }catch(error){feedback(error.message,true);}finally{saving=false;controls.forEach(n=>{n.disabled=false;});el('locations-save-place').disabled=!targetAllowed||!!record&&!record.can_edit;el('locations-new-place').disabled=!targetAllowed;}
    });
    // Administrative controls have their own server permission checks.
    installAdministration({el,node,button,api,configure,getConfig:()=>config,feedback,categories});
    fill();configure().catch(error=>{el('locations-province-note').textContent=error.message;});
    return {schedule,merge,inspect,open,canEditCategory:name=>(config.editable_categories||[]).includes(name)};
}

function installAdministration({el,node,button,api,configure,getConfig,feedback,categories}) {
    const knownFields=new Map();
    el('locations-load-team').addEventListener('click',async()=>{
        const root=el('locations-team-list');root.replaceChildren();
        try{const data=await api('/api/admin/poi/editors');data.users.filter(u=>!u.admin).forEach(user=>{
            const card=node('div',null,'locations-review-card');card.append(node('h3',user.name));
            const active=node('input');active.type='checkbox';active.checked=!!user.grant?.active;
            const review=node('input');review.type='checkbox';review.checked=!!user.grant?.can_review;
            const all=node('input');all.type='checkbox';all.checked=!!user.grant?.all_provinces;
            for(const [input,text] of [[active,'عضو تیم ویرایش'],[review,'اجازهٔ بررسی'],[all,'همهٔ استان‌ها']]){const label=node('label',text);label.prepend(input);card.append(label);}
            const provinces=node('select');provinces.multiple=true;provinces.setAttribute('aria-label','استان‌های مجاز');
            getConfig().coverage.provinces.forEach(p=>{const o=node('option',p.province);o.value=p.province;o.selected=!!user.grant?.provinces.includes(p.province);provinces.append(o);});
            card.append(provinces,button('ذخیرهٔ دسترسی',async()=>{try{await api(`/api/admin/poi/editors/${user.id}`,{method:'PATCH',body:JSON.stringify({active:active.checked,can_review:review.checked,all_provinces:all.checked,provinces:[...provinces.selectedOptions].map(o=>o.value)})});feedback('دسترسی ذخیره شد.');}catch(error){feedback(error.message,true);}}));root.append(card);});
        }catch(error){feedback(error.message,true);}
    });
    el('locations-field-form').addEventListener('submit',async event=>{
        event.preventDefault();const form=el('locations-field-form');if(!form.reportValidity())return;
        const key=el('locations-field-key').value.trim();
        try{await api(`/api/admin/poi/fields/${encodeURIComponent(key)}`,{method:'PATCH',body:JSON.stringify({label:el('locations-field-label').value.trim(),kind:el('locations-field-kind').value,
            categories:[...el('locations-field-categories').selectedOptions].map(o=>o.value),choices:el('locations-field-choices').value.split('\n').map(s=>s.trim()).filter(Boolean),
            required:el('locations-field-required').checked,public:el('locations-field-public').checked,active:el('locations-field-active').checked,
            constraints:knownFields.get(key)?.constraints||getConfig().fields.find(field=>field.key===key)?.constraints||{}})});await configure();feedback('ویژگی ذخیره شد.');
        }catch(error){feedback(error.message,true);}
    });
    categories.forEach(c=>{const o=node('option',c.title);o.value=c.category;el('locations-field-categories').append(o);});
    el('locations-load-fields').addEventListener('click',async()=>{
        try{const data=await api('/api/admin/poi/fields');data.fields.forEach(field=>knownFields.set(field.key,field));const root=el('locations-defined-fields');root.replaceChildren();data.fields.forEach(field=>root.append(button(field.label,()=>{
            el('locations-field-key').value=field.key;el('locations-field-label').value=field.label;el('locations-field-kind').value=field.kind;
            el('locations-field-choices').value=field.choices.join('\n');['required','public','active'].forEach(k=>{el('locations-field-'+k).checked=field[k];});
            [...el('locations-field-categories').options].forEach(o=>{o.selected=field.categories.includes(o.value);});
        })));}catch(error){feedback(error.message,true);}
    });
}
