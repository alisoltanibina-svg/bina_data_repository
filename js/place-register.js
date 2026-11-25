onReady(async()=>{
    const {api,node,page,normalize,provinceAllowed}=PlaceUI,el=id=>document.getElementById(id),form=el('place-registration-form');
    const venue=new URLSearchParams(window.location.search).get('venue');let config,record=null,point=null,submission,dirty=false,saving=false;
    const inputs=new Map();const message=(text,error=false)=>{el('place-form-status').textContent=text;el('place-form-status').classList.toggle('is-error',error);};
    const photo=PlacePhotoPicker({onChange:()=>{dirty=true;submission=crypto.randomUUID();}});
    function readPoint(){try{const data=JSON.parse(sessionStorage.getItem('place-registration')||'null');
        if(!data||data.category!=='mosque'||!Number.isFinite(data.latitude)||!Number.isFinite(data.longitude)||
            !Number.isFinite(data.created_at)||Date.now()-data.created_at>86400000||data.venue_id!==(venue||null))return null;return data;
    }catch{return null;}}
    function renderFields(values){
        for(const field of PlaceUI.definitions(config,point.province)){const label=node('label',field.label);let input;
            if(field.kind==='boolean'||field.kind==='choice'){input=node('select');const blank=node('option','نامشخص');blank.value='';input.append(blank);
                for(const [value,title] of field.kind==='boolean'?[['true','بله'],['false','خیر']]:field.choices.map(v=>[v,v])){const o=node('option',title);o.value=value;input.append(o);}
            }else{input=node('input');input.type=field.kind==='number'?'number':'text';const rules=field.constraints||{};
                if(input.type==='number'){input.step=rules.integer?'1':'any';if(rules.minimum!=null)input.min=rules.minimum;if(rules.maximum!=null)input.max=rules.maximum;}else input.maxLength=rules.max_length||2000;}
            input.value=values[field.key]==null?'':String(values[field.key]);input.required=field.required;label.append(input);el('place-attribute-fields').append(label);inputs.set(field.key,{input,field});}
    }
    try{
        config=await api('/api/poi-explore/editor/config');if(!config.permissions.can_edit)throw new Error('دسترسی ثبت یا ویرایش مکان ندارید.');
        point=readPoint();
        if(venue){record=await api('/api/poi-explore/venues/'+encodeURIComponent(venue)+'?draft=true');
            if(!record.can_edit||record.values.category!=='mosque')throw new Error(record.locked_reason||'ویرایش این مکان در دسترس نیست.');
            point=point||{category:'mosque',province:record.attributes.province||record.province,latitude:record.values.latitude,longitude:record.values.longitude};
            el('place-form-title').textContent='ویرایش '+record.values.name;el('place-form-steps').hidden=true;
            el('place-name').value=record.values.name;el('place-address').value=record.values.address||'';el('place-phone').value=record.values.phoneNumber||'';el('place-website').value=record.values.website||'';
            photo.setExisting(record.photo_url);
        }
        if(!point)throw new Error('ابتدا نوع مکان، استان و موقعیت را از روی نقشه انتخاب کنید.');
        if(!provinceAllowed(config,point.province))throw new Error('ثبت مکان در این استان در دسترس نیست.');
        const gate=await api('/api/poi-explore/editor/eligibility?'+new URLSearchParams({category:'mosque',latitude:point.latitude,longitude:point.longitude}));
        if(!gate.eligible||normalize(gate.province)!==normalize(point.province))throw new Error(gate.reason||'موقعیت با استان انتخاب‌شده یکسان نیست.');
        submission=point.submission_id||crypto.randomUUID();el('place-context').textContent='مسجد · '+point.province;
        renderFields(record?.attributes||{});el('place-change-position').href=page('locations.html')+(venue?'?relocate='+encodeURIComponent(venue):'');form.hidden=false;message('');
    }catch(error){message(error.message,true);}
    form.addEventListener('input',()=>{dirty=true;submission=crypto.randomUUID();});
    window.addEventListener('beforeunload',event=>{if(dirty||saving){event.preventDefault();event.returnValue='';}});
    form.addEventListener('submit',async event=>{
        event.preventDefault();if(saving||!point||!form.reportValidity())return;
        const attributes={province:point.province};for(const [key,{input,field}] of inputs){attributes[key]=input.value===''?null:field.kind==='boolean'?input.value==='true':field.kind==='number'?Number(input.value):input.value;}
        // Schedules, source social arrays and retired fields are preserved by the
        // backend; the current form only submits the requested fields.
        const body={submission_id:submission,version:record?.version||0,source_version:record?.source_version||null,
            values:{name:el('place-name').value.trim(),category:'mosque',latitude:point.latitude,longitude:point.longitude,
                address:el('place-address').value.trim()||null,phoneNumber:el('place-phone').value.trim()||null,website:el('place-website').value.trim()||null},
            attributes,reason:venue?'به‌روزرسانی اطلاعات مسجد از فرم ثبت':'ثبت مسجد از فرم اطلاعات مکانی'};
        saving=true;el('place-submit').disabled=true;const controls=[...form.querySelectorAll('input,select,textarea')];controls.forEach(input=>input.disabled=true);message('در حال ارسال…');
        try{Object.assign(body,await photo.upload(point));await api('/api/poi-explore/manual-places'+(venue?'/'+encodeURIComponent(venue):''),{method:venue?'PATCH':'POST',body:JSON.stringify(body)});
            photo.committed();dirty=false;sessionStorage.removeItem('place-registration');form.hidden=true;el('place-success').hidden=false;el('place-form-steps').hidden=true;message('');el('place-success-title').focus();
        }catch(error){message(error.message,true);}finally{saving=false;controls.forEach(input=>input.disabled=false);el('place-submit').disabled=false;}
    });
});
