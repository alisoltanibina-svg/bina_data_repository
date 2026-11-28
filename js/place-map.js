// Live viewing and corrected local overlays; registration has its own wizard.
function LocationEditor({map,categories,canEdit,getScene,onOverlayChange,onSelectCategory}) {
    const {api,page,node}=PlaceUI,el=id=>document.getElementById(id);
    function fact(root,label,value,link=false){
        const item=node('div',null,'place-fact');PlaceUI.fact(item,label,value,link);root.append(item);
    }
    let config,selected=null,timer,controller,generation=0,lastKey='',published=[],suppressed=new Set();
    let profileMarker=null,profileRequest=0,focusBeforeProfile=null;
    let profileLocalId=null,profileLiveKey=null,profileData=null;
    const profile=el('locations-profile');
    const ready=api('/api/poi-explore/editor/config').then(data=>{config=data;canEdit=data.permissions.can_edit;el('locations-add').hidden=!canEdit;return data;});
    ready.catch(()=>{});
    function closeProfile(){++profileRequest;if(profile.open)profile.close();profileLocalId=profileLiveKey=null;profileData=null;profileMarker?.setOpacity?.(1);profileMarker=null;focusBeforeProfile?.focus?.();onOverlayChange();}
    function present(place,marker){
        if(profileMarker&&profileMarker!==marker)profileMarker.setOpacity?.(1);profileMarker=marker;focusBeforeProfile=marker?.getElement?.()||document.activeElement;
        const origin=marker?.getElement?.()?.getBoundingClientRect();marker?.setOpacity?.(0);
        profileLocalId=place.localId||null;profileLiveKey=null;profileData=null;el('locations-detail-loading').hidden=true;
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
        const values=data.values,root=el('locations-detail-body');profileData=data;profileLocalId=data.id;root.replaceChildren();el('locations-detail-title').textContent=values.name;
        fact(root,'نشانی',values.address);fact(root,'شماره تماس',values.phoneNumber);fact(root,'وبسایت یا صفحهٔ اجتماعی',values.website,true);
        fact(root,'استان',data.province||data.attributes?.province);
        for(const field of PlaceUI.definitions(config,data.province))fact(root,field.label,data.attributes?.[field.key]);
        const authors=data.contributors;if(authors){fact(root,data.tag==='added'?'ثبت‌کننده':'ویرایش‌کننده',data.tag==='added'?authors.created_by?.name:authors.last_edited_by?.name);
            if(data.tag==='added'&&authors.last_edited_by?.name!==authors.created_by?.name)fact(root,'آخرین ویرایش‌کننده',authors.last_edited_by?.name);}
        el('locations-detail-status').textContent=data.tag==='added'?'افزوده‌شده در سامانه':data.tag==='edited'?'ویرایش‌شده در سامانه':'اطلاعات ثبت‌شدهٔ مکان';
        const edit=el('locations-detail-edit');edit.hidden=!canEdit;edit.href=page('place-register.html')+'?venue='+encodeURIComponent(data.id);
        if(!data.can_edit){edit.hidden=true;el('locations-detail-lock').textContent=data.locked_reason||'ویرایش این مکان در دسترس نیست.';}
    }
    async function inspect(place,marker,recordKey){
        const request=++profileRequest;present(place,marker);profileLiveKey=recordKey||null;el('locations-detail-loading').hidden=false;
        try{await ready;
            const data=place.localId?await api('/api/poi-explore/venues/'+encodeURIComponent(place.localId)):
                await api('/api/poi-explore/venue-match',{method:'POST',body:JSON.stringify({category:place.category||selected?.category,
                    name:place.name,latitude:place.latitude,longitude:place.longitude})});
            if(request===profileRequest)showDetails(data);
        }catch(error){if(request===profileRequest)el('locations-detail-lock').textContent=error.message;}
        finally{if(request===profileRequest)el('locations-detail-loading').hidden=true;}
    }
    async function open(id){
        const request=++profileRequest;try{await ready;const data=await api('/api/poi-explore/venues/'+encodeURIComponent(id));if(request!==profileRequest)return;
            if(onSelectCategory)await onSelectCategory(data.values.category);map.setView([data.values.latitude,data.values.longitude],15);
            if(request!==profileRequest)return;present(data.values);showDetails(data);
        }catch(error){present({name:'اطلاعات مکان'});el('locations-detail-lock').textContent=error.message;}
    }
    async function refresh(){
        if(controller)controller.abort();const version=++generation;if(!selected||document.hidden)return;const scene=getScene(),bounds=scene.bounds,plan=scene.plan;
        controller=new AbortController();
        if(scene.zoom<8||!plan){published=[];suppressed.clear();onOverlayChange();return;}
        const live=scene.records.map((record,reference)=>({reference,name:record.place.name,latitude:record.place.latitude,longitude:record.place.longitude}));
        const key=JSON.stringify([selected.category,bounds,plan,live,Math.floor(Date.now()/30000)]);if(lastKey===key)return;
        const batches=[];let batch=[],bytes=0;
        const utf8Size=text=>{let total=0;for(const char of text){const code=char.codePointAt(0);total+=code<128?1:code<2048?2:code<65536?3:4;}return total;};
        for(const point of live){const size=utf8Size(JSON.stringify(point))+1;
            if(batch.length&&(batch.length>=200||bytes+size>55000)){batches.push(batch);batch=[];bytes=0;}batch.push(point);bytes+=size;}
        if(batch.length||!batches.length)batches.push(batch);
        try{const rows=new Map(),hidden=new Set();let hasMore=false;
            for(let offset=0;offset<batches.length;offset++){
                const data=await api('/api/poi-explore/overlays',{method:'POST',signal:controller.signal,body:JSON.stringify({category:selected.category,...bounds,
                    latitude:plan.latitude,longitude:plan.longitude,radius:plan.radius,zoom:Math.floor(scene.zoom),live_places:batches[offset],include_places:offset===0})});
                data.places.forEach(row=>rows.set(row.id,row));(data.suppressed_refs||[]).forEach(reference=>{const record=scene.records[reference];if(record)hidden.add(record.key);});hasMore ||= data.has_more;}
            if(version!==generation)return;published=[...rows.values()];suppressed=hidden;lastKey=key;onOverlayChange();el('locations-overlay-note').hidden=!hasMore;
        }catch(error){if(error.name!=='AbortError'&&version===generation){lastKey='';el('locations-overlay-note').textContent='دریافت مکان‌های ثبت‌شده انجام نشد.';el('locations-overlay-note').hidden=false;}}
    }
    function schedule(category=selected){if(selected?.category!==category?.category){published=[];suppressed.clear();lastKey='';}
        selected=category;if(controller)controller.abort();++generation;clearTimeout(timer);timer=setTimeout(refresh,200);}
    function merge(records,bounds,zoom){
        const output=records.filter(record=>{
            if(suppressed.has(record.key))return false;
            if(!profile.open)return true;
            if(profileLiveKey&&record.key===profileLiveKey||record.place.localId===profileLocalId&&profileLocalId)return false;
            if(profileData&&LocationDiscovery.samePlace({...record.place,category:record.category},
                {...profileData.values,province_name:profileData.province}))return false;
            return true;
        });
        if(zoom<8)return output;const plan=getScene().plan;if(!plan)return output;
        for(const place of published){if(profile.open&&place.id===profileLocalId)continue;if(!LocationDiscovery.inside(place,bounds)||LocationDiscovery.distance(place,plan)>plan.radius)continue;
            output.push({key:`local/${place.id}/${place.published_version||0}`,category:place.category,place:{...place,localId:place.id,id:place.id}});}return output;
    }
    el('locations-add').addEventListener('click',()=>{window.location.href=page('place-register.html');});
    el('locations-detail-close').addEventListener('click',closeProfile);profile.addEventListener('cancel',event=>{event.preventDefault();closeProfile();});
    profile.addEventListener('close',()=>{profileMarker?.setOpacity?.(1);profileMarker=null;});
    window.addEventListener('pagehide',()=>{clearTimeout(timer);controller?.abort();});
    function relocate(id){window.location.replace(page('place-register.html')+'?venue='+encodeURIComponent(id)+'&step=3');}
    function resume(){window.location.replace(page('place-register.html')+'?step=3');}
    return {schedule,merge,inspect,open,relocate,resume};
}
