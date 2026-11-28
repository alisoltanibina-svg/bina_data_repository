// Registration uses the Neshan basemap and our own place records only.
function PlaceRegistrationMap({onPoint,onValidity,onZoom}) {
    const {api,normalize}=PlaceUI,el=id=>document.getElementById(id);
    let map,loading,geo,area,marker,places,targetId,province='',category='',iconUrl='',point,visible=false;
    let timer,controller,gateController,generation=0,gateGeneration=0,showGeneration=0;
    const note=text=>el('place-map-status').textContent=text;
    function selectedIcon(size=36){return L.icon({iconUrl,iconSize:[size,size],iconAnchor:[size/2,size/2],className:'place-registration-pin'});}
    async function initialize(){
        if(map)return;
        if(loading)return loading;
        loading=(async()=>{
            if(typeof L==='undefined')throw new Error('بارگذاری نقشه انجام نشد؛ صفحه را دوباره باز کنید.');
            const [settings,boundaries]=await Promise.all([api('/api/maps/config'),fetch('../data/iran.geojson',{credentials:'same-origin'}).then(r=>{
                if(!r.ok)throw new Error('دریافت محدودهٔ استان انجام نشد.');return r.json();})]);
            geo=boundaries;map=new L.Map('place-registration-map',{key:settings.key,maptype:settings.maptype,minZoom:4,maxZoom:19,preferCanvas:true,zoomControl:true});
            map.attributionControl.setPrefix(false);places=L.layerGroup().addTo(map);map.setView([32,53.5],5);
            map.on('click',event=>select({latitude:event.latlng.lat,longitude:event.latlng.lng}));
            map.on('moveend',schedule);map.on('zoomend',()=>{onZoom(map.getZoom());schedule();});
        })();
        try{await loading;}finally{loading=null;}
    }
    function drawPoint(){
        marker?.remove();marker=null;if(!point)return;
        marker=L.marker([point.latitude,point.longitude],{draggable:true,zIndexOffset:1000,icon:selectedIcon()}).addTo(map);
        marker.on('dragstart',()=>{++gateGeneration;gateController?.abort();onValidity(false);});
        marker.on('dragend',event=>{const position=event.target.getLatLng();select({latitude:position.lat,longitude:position.lng});});
    }
    function select(candidate){
        if(!visible)return;
        point=candidate;drawPoint();onPoint(candidate);check().catch(()=>{});
    }
    async function check(){
        const request=++gateGeneration;gateController?.abort();gateController=new AbortController();onValidity(false);
        if(!point){el('place-point-status').textContent='محل مسجد را روی نقشه انتخاب کنید.';return false;}
        const candidate={...point};el('place-point-status').textContent='در حال بررسی موقعیت…';
        try{
            const result=await api('/api/poi-explore/editor/eligibility?'+new URLSearchParams({category,...candidate}),{signal:gateController.signal});
            if(request!==gateGeneration)return false;
            if(!result.eligible||normalize(result.province)!==normalize(province))throw new Error(result.eligible?'نقطه باید داخل استان انتخاب‌شده باشد.':result.reason||'ثبت مکان در این محدوده فعال نیست.');
            el('place-point-status').textContent='';onValidity(true);return true;
        }catch(error){if(request===gateGeneration&&error.name!=='AbortError')el('place-point-status').textContent=error.message;return false;}
    }
    async function refresh(){
        if(!map||!visible||!province)return;
        controller?.abort();controller=new AbortController();const request=++generation,b=map.getBounds();
        const bounds={south:Math.max(24,b.getSouth()),north:Math.min(41,b.getNorth()),west:Math.max(43,b.getWest()),east:Math.min(64,b.getEast())};
        if(bounds.south>bounds.north||bounds.west>bounds.east){places.clearLayers();return;}
        try{
            const result=await api('/api/poi-explore/editor/places?'+new URLSearchParams({category,province,...bounds}),{signal:controller.signal});
            if(request!==generation||!visible)return;places.clearLayers();
            for(const row of result.places){if(row.id===targetId)continue;const item=L.marker([row.latitude,row.longitude],{icon:selectedIcon(25),title:row.name,opacity:.75});
                const title=document.createElement('span');title.textContent=row.name;item.bindTooltip(title);item.addTo(places);}
            note('');
        }catch(error){if(request===generation&&error.name!=='AbortError')note(error.message);}
    }
    function schedule(){clearTimeout(timer);if(visible)timer=setTimeout(refresh,250);}
    function reset(){if(area)map.fitBounds(area.getBounds(),{padding:[25,25],maxZoom:11});}
    async function show(data,categories,placeId){
        const request=++showGeneration;visible=true;el('place-map-retry').hidden=true;
        try{
            await initialize();if(request!==showGeneration||!visible)return;map.invalidateSize();
            category=data.category;targetId=placeId;iconUrl=PlaceUI.categoryIcon(categories.find(row=>row.category===category)||{category,icon_url:'https://static.neshanmap.ir/poi/64/mosque.png'});
            const changed=normalize(province)!==normalize(data.province);province=data.province;
            if(changed||!area){
                const feature=geo.features.find(f=>normalize(f.properties.ADM1_FA||f.properties.ProvincNam||f.properties.Name||f.properties.name)===normalize(province));
                if(!feature)throw new Error('محدودهٔ استان یافت نشد.');
                area?.remove();area=L.geoJSON(feature,{interactive:false,style:{color:'#aa965f',weight:2,fillColor:'#515811',fillOpacity:.025}}).addTo(map);
            }
            point=Number.isFinite(data.latitude)&&Number.isFinite(data.longitude)?{latitude:data.latitude,longitude:data.longitude}:null;drawPoint();
            if(point)map.setView([point.latitude,point.longitude],data.zoom||16,{animate:false});else reset();
            schedule();await check();
        }catch(error){note(error.message);el('place-map-retry').hidden=false;onValidity(false);}
    }
    function hide(){visible=false;++showGeneration;clearTimeout(timer);controller?.abort();gateController?.abort();++gateGeneration;++generation;}
    window.addEventListener('pagehide',()=>{hide();gateController?.abort();});
    return {show,hide,check,reset};
}
