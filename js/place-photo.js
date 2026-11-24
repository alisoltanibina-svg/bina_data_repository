// One rectangular photograph per proposal. The original is validated/cropped on the server.
function PlacePhotoPicker({onChange}) {
    const el=id=>document.getElementById(id),dialog=el('place-photo-crop'),canvas=el('place-photo-canvas'),context=canvas.getContext('2d');
    let source=null,pendingFile=null,file=null,crop=null,scale=1,minimum=1,x=0,y=0,drag=null,originalUrl=null,previewUrl=null,uploaded=null,existing=null,remove=false,cropRequest=0;
    const status=text=>el('place-photo-status').textContent=text;
    function clearPreviewUrl(){if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null;}}
    function preview(url){const img=el('place-photo-preview');img.hidden=!url;if(url)img.src=url;else img.removeAttribute('src');el('place-photo-remove').hidden=!url;}
    function draw(){if(!source)return;x=Math.min(0,Math.max(800-source.naturalWidth*scale,x));y=Math.min(0,Math.max(600-source.naturalHeight*scale,y));
        context.fillStyle='#fff';context.fillRect(0,0,800,600);context.drawImage(source,x,y,source.naturalWidth*scale,source.naturalHeight*scale);}
    function close(){++cropRequest;dialog.close();source=null;pendingFile=null;drag=null;if(originalUrl){URL.revokeObjectURL(originalUrl);originalUrl=null;}el('place-photo-file').value='';}
    async function discard(){if(!uploaded)return;const id=uploaded;uploaded=null;try{await PlaceUI.api('/api/poi-explore/photos/'+id,{method:'DELETE'});}catch{/* Unused staged photos expire independently. */}}
    el('place-photo-file').addEventListener('change',async event=>{
        const candidate=event.target.files[0];if(!candidate)return;
        if(candidate.size>5*1024*1024){status('حجم عکس باید حداکثر ۵ مگابایت باشد.');event.target.value='';return;}
        if(!/\.(png|jpe?g|webp)$/i.test(candidate.name)||(candidate.type&&!['image/png','image/jpeg','image/webp'].includes(candidate.type))){status('فقط PNG، JPEG یا WebP انتخاب کنید.');event.target.value='';return;}
        status('');pendingFile=candidate;const image=new Image();originalUrl=URL.createObjectURL(candidate);
        image.onload=()=>{if(pendingFile!==candidate)return;
            if(image.naturalWidth*image.naturalHeight>25000000||Math.max(image.naturalWidth,image.naturalHeight)>10000||Math.min(image.naturalWidth,image.naturalHeight)<32){status('ابعاد تصویر مناسب نیست.');close();return;}
            source=image;minimum=Math.max(800/image.naturalWidth,600/image.naturalHeight);scale=minimum;x=(800-image.naturalWidth*scale)/2;y=(600-image.naturalHeight*scale)/2;
            el('place-photo-zoom').value='1';dialog.showModal();draw();canvas.focus();};
        image.onerror=()=>{status('فایل تصویر معتبر نیست.');close();};image.src=originalUrl;
    });
    el('place-photo-zoom').addEventListener('input',()=>{if(!source)return;const next=minimum*Number(el('place-photo-zoom').value);const factor=next/scale;
        x=400-(400-x)*factor;y=300-(300-y)*factor;scale=next;draw();});
    canvas.addEventListener('pointerdown',event=>{if(!source)return;event.preventDefault();drag={id:event.pointerId,x:event.clientX,y:event.clientY};canvas.setPointerCapture(event.pointerId);});
    canvas.addEventListener('pointermove',event=>{if(!drag||drag.id!==event.pointerId)return;const rect=canvas.getBoundingClientRect();x+=(event.clientX-drag.x)*800/rect.width;y+=(event.clientY-drag.y)*600/rect.height;
        drag.x=event.clientX;drag.y=event.clientY;draw();});
    for(const type of ['pointerup','pointercancel'])canvas.addEventListener(type,()=>drag=null);
    canvas.addEventListener('keydown',event=>{const moves={ArrowLeft:[-16,0],ArrowRight:[16,0],ArrowUp:[0,-16],ArrowDown:[0,16]};if(!moves[event.key])return;event.preventDefault();x+=moves[event.key][0];y+=moves[event.key][1];draw();});
    el('place-photo-cancel').addEventListener('click',close);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    el('place-photo-apply').addEventListener('click',async()=>{
        if(!source)return;const request=++cropRequest,chosen=pendingFile,selection={x:Math.max(0,-x/scale),y:Math.max(0,-y/scale),width:800/scale,height:600/scale};
        el('place-photo-apply').disabled=true;
        try{const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.92));if(request!==cropRequest)return;if(!blob)throw new Error('آماده‌سازی تصویر انجام نشد.');
            await discard();if(request!==cropRequest)return;file=chosen;crop=selection;remove=false;clearPreviewUrl();previewUrl=URL.createObjectURL(blob);preview(previewUrl);onChange();close();status('');
        }catch(error){status(error.message);}finally{el('place-photo-apply').disabled=false;}
    });
    el('place-photo-remove').addEventListener('click',async()=>{await discard();file=crop=null;remove=true;clearPreviewUrl();preview(null);onChange();});
    window.addEventListener('pagehide',()=>{clearPreviewUrl();if(originalUrl)URL.revokeObjectURL(originalUrl);});
    return {
        setExisting(url){existing=PlaceUI.photoUrl(url)?url:null;preview(PlaceUI.photoUrl(existing));},
        async upload(point){
            if(remove)return {remove_photo:true};
            if(file&&!uploaded){const data=new FormData();data.append('file',file);data.append('crop',JSON.stringify(crop));data.append('latitude',point.latitude);data.append('longitude',point.longitude);
                const response=await fetch(`${window.API_BASE_URL||''}/api/poi-explore/photos`,{method:'POST',credentials:'include',cache:'no-store',headers:{'X-CSRF-Protection':'1'},body:data});
                const result=await response.json();if(!response.ok)throw new Error(typeof result.detail==='string'?result.detail:'بارگذاری عکس انجام نشد.');uploaded=result.id;}
            const id=uploaded||(existing?existing.split('/').pop():null);return id?{photo_id:id}:{};
        },
        committed(){uploaded=null;},
    };
}
