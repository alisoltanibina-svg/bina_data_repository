// Viewing stays live; choosing a registration point uses only our database.
function LocationEditor({map,categories,canEdit,onModeChange,getScene,onOverlayChange,onSelectCategory}) {
    const {api,node,page,normalize,fact,provinceAllowed}=PlaceUI,el=id=>document.getElementById(id);
    let config,selected=null,timer,controller,generation=0,lastKey='',published=[],suppressed=new Set();
    let picking=false,province='',point=null,draftMarker=null,provinceLayer=null,profileMarker=null,profileRequest=0,focusBeforeProfile=null,relocatingId=null,addRequest=0;
    let profileIdentity=null,profileLiveIdentity=null,profileLocalId=null;
    const layer=L.layerGroup().addTo(map),profile=el('locations-profile'),addDialog=el('locations-add-dialog');
    const ready=api('/api/poi-explore/editor/config').then(data=>{
        config=data;el('locations-add').hidden=!data.permissions.can_edit;
        for(const category of categories){const button=node('button',category.title,'place-type-choice');button.type='button';
            button.disabled=category.category!=='mosque'||!data.editable_categories.includes(category.category);
            const icon=node('img');icon.src=category.icon_url;icon.alt='';button.prepend(icon);
            button.addEventListener('click',()=>{
                el('locations-type-step').hidden=true;el('locations-province-step').hidden=false;el('locations-add-title').textContent='استان را انتخاب کنید';
                el('locations-add-province').focus();});el('locations-add-types').append(button);}
        for(const row of data.coverage.provinces){const option=node('option',row.province+(provinceAllowed(data,row.province)?'':' — غیرفعال'));option.value=row.province;el('locations-add-province').append(option);}
        return data;
    }).catch(error=>{el('locations-add-error').textContent=error.message;throw error;});
    ready.catch(()=>{});
    function closeProfile(){++profileRequest;if(profile.open)profile.close();profileIdentity=profileLiveIdentity=profileLocalId=null;profileMarker?.setOpacity?.(1);profileMarker=null;focusBeforeProfile?.focus?.();onOverlayChange();}
    function present(place,marker){
        if(profileMarker&&profileMarker!==marker)profileMarker.setOpacity?.(1);profileMarker=marker;focusBeforeProfile=marker?.getElement?.()||document.activeElement;
        const origin=marker?.getElement?.()?.getBoundingClientRect();marker?.setOpacity?.(0);
        profileIdentity=profileLiveIdentity=place.id||null;profileLocalId=place.localId||null;el('locations-detail-loading').hidden=true;
        el('locations-detail-title').textContent=place.name||'اطلاعات مکان';el('locations-detail-body').replaceChildren();
        el('locations-detail-lock').textContent='';el('locations-detail-status').textContent='';el('locations-detail-edit').hidden=true;
        const image=el('locations-profile-icon');image.alt='';image.classList.remove('is-place-photo');image.onerror=null;image.src=(categories.find(c=>c.category===place.category)||selected||categories[0])?.icon_url||'';
        if(!profile.open)profile.showModal();
        if(origin&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches&&image.animate){const target=image.getBoundingClientRect();
            const x=origin.left+origin.width/2-target.left-target.width/2,y=origin.top+origin.height/2-target.top-target.height/2;
            image.animate([{transform:`translate(${x}px,${y}px) scale(${origin.width/target.width})`,opacity:.4},{transform:'translate(0,0) scale(1)',opacity:1}],{duration:420,easing:'cubic-bezier(.22,.7,.2,1)'});}
    }
    function showDetails(data){
        const image=el('locations-profile-icon'),photoUrl=PlaceUI.photoUrl(data.photo_url);
        if(photoUrl){const fallback=image.src;image.classList.add('is-place-photo');image.alt='عکس '+data.values.name;image.src=photoUrl;image.onerror=()=>{image.onerror=null;image.alt='';image.classList.remove('is-place-photo');image.src=fallback;};}
        const values=data.values,root=el('locations-detail-body');profileIdentity=data.match_id||data.identity||profileIdentity;profileLocalId=data.id;root.replaceChildren();el('locations-detail-title').textContent=values.name;
        fact(root,'نشانی',values.address);fact(root,'شماره تماس',values.phoneNumber);fact(root,'وبسایت یا صفحهٔ اجتماعی',values.website,true);
        fact(root,'استان',data.province||data.attributes?.province);
        for(const field of PlaceUI.definitions(config))fact(root,field.label,data.attributes?.[field.key]);
        const authors=data.contributors;if(authors){fact(root,data.tag==='added'?'ثبت‌کننده':'ویرایش‌کننده',data.tag==='added'?authors.created_by?.name:authors.last_edited_by?.name);
            if(data.tag==='added'&&authors.last_edited_by?.name!==authors.created_by?.name)fact(root,'آخرین ویرایش‌کننده',authors.last_edited_by?.name);}
        el('locations-detail-status').textContent=data.tag==='added'?'افزوده‌شده در سامانه':data.tag==='edited'?'ویرایش‌شده در سامانه':'اطلاعات ثبت‌شدهٔ مکان';
        const edit=el('locations-detail-edit');edit.hidden=!canEdit||picking;edit.href=page('place-register.html')+'?venue='+encodeURIComponent(data.id);
        if(!data.can_edit){edit.hidden=true;el('locations-detail-lock').textContent=data.locked_reason||'ویرایش این مکان در دسترس نیست.';}
    }
    async function inspect(place,marker){
        const request=++profileRequest;present(place,marker);el('locations-detail-loading').hidden=false;
        try{await ready;const lookup=place.lookup_id||place.id;
            const path=place.localId?'/api/poi-explore/venues/'+encodeURIComponent(place.localId):lookup?'/api/poi-explore/venue-match/'+encodeURIComponent(lookup):null;
            if(!path)throw new Error('شناسهٔ قابل تطبیق برای این مکان دریافت نشده است.');
            const params=new URLSearchParams();
            if(!place.localId&&Number.isFinite(place.latitude)&&Number.isFinite(place.longitude)){
                params.set('latitude',place.latitude);params.set('longitude',place.longitude);
                if(place.identity_scheme==='neshan-prefix32-v1'){params.set('prefix32_key',place.id);params.set('category',place.category||selected?.category||'');}
            }
            const query=params.size?'?'+params:'';
            const data=await api(path+query);if(request===profileRequest)showDetails(data);
        }catch(error){if(request===profileRequest)el('locations-detail-lock').textContent=error.status===404?'اطلاعات این مکان هنوز در پایگاه داده ثبت نشده است.':error.message;}
        finally{if(request===profileRequest)el('locations-detail-loading').hidden=true;}
    }
    async function open(id){
        const request=++profileRequest;try{await ready;const data=await api('/api/poi-explore/venues/'+encodeURIComponent(id));if(request!==profileRequest)return;
            if(onSelectCategory)await onSelectCategory(data.values.category);map.setView([data.values.latitude,data.values.longitude],15);
            if(request!==profileRequest)return;present(data.values);showDetails(data);
        }catch(error){present({name:'اطلاعات مکان'});el('locations-detail-lock').textContent=error.message;}
    }
    async function chooseProvince(){
        const name=el('locations-add-province').value;if(!config||!provinceAllowed(config,name))return;
        const request=++addRequest;
        el('locations-add-next').disabled=true;el('locations-add-error').textContent='';
        try{const response=await fetch('../data/iran.geojson',{credentials:'same-origin'});if(!response.ok)throw new Error('دریافت محدودهٔ استان انجام نشد.');
            const geo=await response.json();const feature=geo.features.find(f=>normalize(f.properties.ADM1_FA||f.properties.ProvincNam||f.properties.Name)===normalize(name));
            if(!feature)throw new Error('محدودهٔ استان یافت نشد.');if(request!==addRequest||!addDialog.open)return;
            const area=L.geoJSON(feature,{interactive:false,style:{color:'#aa965f',weight:2,fillColor:'#515811',fillOpacity:.025}});const bounds=area.getBounds();
            provinceLayer?.remove?.();provinceLayer=area;area.addTo?.(map);
            province=name;point=null;++pointRequest;picking=true;document.body.classList.add('is-selecting-point');closeProfile();addDialog.close();el('locations-point-step').hidden=false;
            el('locations-point-title').textContent='ثبت مسجد · '+province;el('locations-point-next').disabled=true;
            el('locations-point-hint').textContent='محل مسجد را روی نقشه انتخاب کنید. نمادها، مکان‌های ثبت‌شدهٔ پایگاه داده هستند.';
            onModeChange(true);await onSelectCategory?.('mosque');map.fitBounds(bounds,{padding:[60,100],maxZoom:11});schedule();
        }catch(error){if(request===addRequest){el('locations-add-error').textContent=error.message;el('locations-add-next').disabled=false;}}
    }
    function cancelPoint(){++pointRequest;picking=false;point=null;relocatingId=null;document.body.classList.remove('is-selecting-point');if(draftMarker){draftMarker.remove();draftMarker=null;}provinceLayer?.remove?.();provinceLayer=null;layer.clearLayers();el('locations-point-step').hidden=true;onModeChange(false);lastKey='';schedule();}
    let pointRequest=0;
    map.on('click',async event=>{
        if(!picking)return;const request=++pointRequest;point=null;el('locations-point-next').disabled=true;
        if(draftMarker)draftMarker.remove();const candidate={latitude:event.latlng.lat,longitude:event.latlng.lng};
        draftMarker=L.marker([candidate.latitude,candidate.longitude],{icon:L.icon({iconUrl:categories.find(c=>c.category==='mosque')?.icon_url,iconSize:[38,38],iconAnchor:[19,19],className:'locations-live-icon locations-manual-icon'})}).addTo(map);
        el('locations-point-hint').textContent='در حال بررسی موقعیت…';
        try{const result=await api('/api/poi-explore/editor/eligibility?'+new URLSearchParams({category:'mosque',...candidate}));if(!picking||request!==pointRequest)return;
            if(!result.eligible||normalize(result.province)!==normalize(province))throw new Error(result.eligible?'نقطه باید در استان انتخاب‌شده باشد.':result.reason);
            point=candidate;el('locations-point-next').disabled=false;el('locations-point-hint').textContent='موقعیت انتخاب شد. برای ثبت اطلاعات ادامه دهید.';
        }catch(error){if(picking&&request===pointRequest)el('locations-point-hint').textContent=error.message;}
    });
    async function refresh(){
        if(controller)controller.abort();const version=++generation;if(!selected||document.hidden)return;const scene=getScene(),bounds=scene.bounds,plan=scene.plan;
        controller=new AbortController();
        if(picking){
            try{const data=await api('/api/poi-explore/editor/places?'+new URLSearchParams({category:'mosque',province,...bounds}),{signal:controller.signal});
                if(version!==generation||!picking)return;layer.clearLayers();data.places.forEach(row=>L.marker([row.latitude,row.longitude],{
                    icon:L.icon({iconUrl:selected.icon_url,iconSize:[26,26],iconAnchor:[13,13],className:'locations-live-icon locations-database-icon'}),title:row.name})
                    .on('click',()=>inspect({localId:row.id,name:row.name,category:'mosque'})).addTo(layer));
                if(data.has_more)el('locations-point-hint').textContent='برای دیدن مکان‌های ثبت‌شدهٔ بیشتر، نقشه را بزرگ‌تر کنید.';
            }catch(error){if(error.name!=='AbortError'&&version===generation)el('locations-point-hint').textContent=error.message;}return;
        }
        layer.clearLayers();if(scene.zoom<8||!plan){published=[];suppressed.clear();onOverlayChange();return;}
        const identities=[...new Set(scene.records.map(r=>r.place.lookup_id||r.place.id).filter(id=>/^[a-f0-9]{64}$/.test(id||'')))];
        const stableKeys=[...new Set(scene.records.filter(r=>r.place.identity_scheme==='neshan-prefix32-v1').map(r=>r.place.id).filter(id=>/^[a-f0-9]{64}$/.test(id||'')))];
        const key=JSON.stringify([selected.category,bounds,plan,identities,stableKeys,Math.floor(Date.now()/30000)]);if(lastKey===key)return;
        try{const rows=new Map(),hidden=new Set(),prefixes=[...new Set(identities.map(id=>id.slice(0,8)))];let hasMore=false;
            // Keep each JSON request below the API's 64 KiB input cap.
            const width=stableKeys.length?2500:5000;
            for(let offset=0;offset<Math.max(1,Math.ceil(prefixes.length/width),Math.ceil(stableKeys.length/500));offset++){
                const data=await api('/api/poi-explore/overlays',{method:'POST',signal:controller.signal,body:JSON.stringify({category:selected.category,...bounds,
                    latitude:plan.latitude,longitude:plan.longitude,radius:plan.radius,zoom:Math.floor(scene.zoom),prefixes:prefixes.slice(offset*width,(offset+1)*width),
                    ...(stableKeys.length?{prefix32_keys:stableKeys.slice(offset*500,(offset+1)*500)}:{}),include_places:offset===0})});
                data.places.forEach(row=>rows.set(row.id,row));data.suppressed.forEach(id=>hidden.add(id));(data.suppressed_prefix32||[]).forEach(id=>hidden.add(id));hasMore ||= data.has_more;}
            if(version!==generation)return;published=[...rows.values()];suppressed=hidden;lastKey=key;onOverlayChange();el('locations-overlay-note').hidden=!hasMore;
        }catch(error){if(error.name!=='AbortError'&&version===generation){lastKey='';el('locations-overlay-note').textContent='دریافت مکان‌های ثبت‌شده انجام نشد.';el('locations-overlay-note').hidden=false;}}
    }
    function schedule(category=selected){if(selected?.category!==category?.category){published=[];suppressed.clear();lastKey='';layer.clearLayers();}
        selected=category;if(controller)controller.abort();++generation;clearTimeout(timer);timer=setTimeout(refresh,200);}
    function merge(records,bounds,zoom){if(picking)return [];const output=records.filter(r=>!suppressed.has(r.place.id)&&!suppressed.has(r.place.lookup_id)&&!(profile.open&&(r.place.id===profileIdentity||r.place.id===profileLiveIdentity||r.place.localId===profileLocalId)));if(zoom<8)return output;const plan=getScene().plan;if(!plan)return output;
        for(const place of published){if(profile.open&&(place.id===profileLocalId||place.identity&&place.identity===profileIdentity))continue;if(!LocationDiscovery.inside(place,bounds)||LocationDiscovery.distance(place,plan)>plan.radius)continue;
            output.push({key:`local/${place.id}/${place.published_version||0}`,category:place.category,place:{...place,localId:place.id,id:place.match_id||place.identity||undefined}});}return output;}
    el('locations-add').addEventListener('click',async()=>{try{await ready;if(!config.permissions.can_edit)return;if(picking)cancelPoint();relocatingId=null;
        el('locations-type-step').hidden=false;el('locations-province-step').hidden=true;el('locations-add-title').textContent='نوع مکان را انتخاب کنید';addDialog.showModal();
    }catch(error){el('locations-add-error').textContent=error.message;}});
    el('locations-add-close').addEventListener('click',()=>{++addRequest;addDialog.close();});addDialog.addEventListener('cancel',()=>{++addRequest;});
    el('locations-add-back').addEventListener('click',()=>{el('locations-type-step').hidden=false;el('locations-province-step').hidden=true;el('locations-add-title').textContent='نوع مکان را انتخاب کنید';});
    el('locations-add-province').addEventListener('change',()=>{const allowed=provinceAllowed(config,el('locations-add-province').value);
        el('locations-add-next').disabled=!allowed;el('locations-add-eligibility').textContent=allowed?'ثبت مکان در این استان فعال است.':'ثبت مکان در این استان هنوز فعال نیست یا دسترسی آن را ندارید.';});
    el('locations-add-next').addEventListener('click',chooseProvince);el('locations-point-cancel').addEventListener('click',cancelPoint);
    el('locations-point-next').addEventListener('click',()=>{if(!picking||!point)return;try{sessionStorage.setItem('place-registration',JSON.stringify({category:'mosque',province,...point,venue_id:relocatingId,created_at:Date.now(),submission_id:crypto.randomUUID()}));
        window.location.href=page('place-register.html')+(relocatingId?'?venue='+encodeURIComponent(relocatingId):'');}catch{el('locations-point-hint').textContent='ذخیرهٔ موقت فرم ممکن نشد؛ تنظیمات مرورگر را بررسی کنید.';}});
    el('locations-detail-close').addEventListener('click',closeProfile);profile.addEventListener('cancel',event=>{event.preventDefault();closeProfile();});
    profile.addEventListener('close',()=>{profileMarker?.setOpacity?.(1);profileMarker=null;});
    window.addEventListener('pagehide',()=>{clearTimeout(timer);controller?.abort();});
    async function relocate(id){try{await ready;const data=await api('/api/poi-explore/venues/'+encodeURIComponent(id));if(!data.can_edit||data.values.category!=='mosque')throw new Error(data.locked_reason||'ویرایش موقعیت در دسترس نیست.');
        relocatingId=id;el('locations-type-step').hidden=true;el('locations-province-step').hidden=false;el('locations-add-title').textContent='استان موقعیت جدید را انتخاب کنید';
        el('locations-add-province').value=data.province||data.attributes.province;el('locations-add-province').dispatchEvent(new Event('change'));addDialog.showModal();
    }catch(error){present({name:'ویرایش موقعیت'});el('locations-detail-lock').textContent=error.message;}}
    return {schedule,merge,inspect,open,relocate,canEditCategory:name=>!picking||name==='mosque'};
}
