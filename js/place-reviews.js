onReady(async()=>{
    const {api,node,fact,text,page}=PlaceUI,el=id=>document.getElementById(id);let config,loading=false;
    const labels={name:'نام',address:'نشانی',phoneNumber:'شماره تماس',website:'وبسایت یا صفحهٔ اجتماعی',latitude:'عرض جغرافیایی',longitude:'طول جغرافیایی'};
    async function load(){if(loading)return;loading=true;el('place-reviews-refresh').disabled=true;
        try{const data=await api('/api/poi-explore/editor/revisions');const root=el('place-reviews-list');root.replaceChildren();
            for(const revision of data.revisions){const card=node('article',null,'place-review-card'),header=node('header');
                header.append(node('h2',revision.after.name),node('p',revision.action==='added'?'افزودن مکان':'ویرایش مکان'));card.append(header,node('p',revision.actor_name||'کاربر '+revision.actor_id));
                const photo=PlaceUI.photoUrl(revision.photo_url);if(photo){const image=node('img',null,'place-photo-preview');image.src=photo;image.alt='عکس پیشنهادی '+revision.after.name;card.append(image);}
                const dl=node('dl');for(const [key,label] of Object.entries(labels)){
                    if(revision.action==='added'||JSON.stringify(revision.before[key])!==JSON.stringify(revision.after[key]))fact(dl,label,revision.action==='added'?revision.after[key]:text(revision.before[key])+' ← '+text(revision.after[key]));}
                for(const [key,value] of Object.entries(revision.attributes||{})){const field=config.fields.find(f=>f.key===key);if(field?.active)fact(dl,field.label,value);}
                const map=node('a','نمایش موقعیت روی نقشه','place-back');map.href=page('locations.html')+'?venue='+encodeURIComponent(revision.place_id);
                const note=node('textarea');note.placeholder='یادداشت برای ثبت‌کننده';note.setAttribute('aria-label','یادداشت بررسی '+revision.after.name);note.maxLength=1000;
                const feedback=node('p',null,'place-review-error');feedback.setAttribute('role','status');
                const actions=node('div',null,'place-review-actions');let busy=false;
                const decide=async approve=>{if(busy||approve&&revision.is_consolidated_alias)return;busy=true;approveButton.disabled=rejectButton.disabled=true;feedback.textContent='';
                    try{await api('/api/poi-explore/editor/revisions/'+encodeURIComponent(revision.id)+'/review',{method:'POST',body:JSON.stringify({approve,note:note.value.trim()})});card.remove();
                        if(!root.childElementCount)el('place-reviews-status').textContent='پیشنهادی در انتظار بررسی نیست.';
                    }catch(error){feedback.textContent=error.message;}finally{busy=false;approveButton.disabled=!!revision.is_consolidated_alias;rejectButton.disabled=false;}};
                const approveButton=node('button','تأیید و انتشار','place-primary'),rejectButton=node('button','رد پیشنهاد','place-review-reject');
                approveButton.type=rejectButton.type='button';approveButton.addEventListener('click',()=>decide(true));rejectButton.addEventListener('click',()=>decide(false));
                if(revision.is_consolidated_alias){
                    approveButton.disabled=true;card.append(node('p','این پیشنهاد به رکوردی مربوط است که یکپارچه شده است. اطلاعات را در صفحهٔ مکان اصلی دوباره ثبت کنید.'));
                    const reopen=node('a','باز کردن مکان اصلی','place-back');reopen.href=page('place-register.html')+'?venue='+encodeURIComponent(revision.canonical_place_id);card.append(reopen);
                }
                actions.append(approveButton,rejectButton);card.append(dl,map,note,actions,feedback);root.append(card);}
            el('place-reviews-status').textContent=data.revisions.length?'':'پیشنهادی در انتظار بررسی نیست.';
        }catch(error){el('place-reviews-status').textContent=error.message;}finally{loading=false;el('place-reviews-refresh').disabled=false;}}
    try{config=await api('/api/poi-explore/editor/config');if(!config.permissions.can_review)throw new Error('دسترسی بررسی مشارکت‌ها ندارید.');
        el('place-reviews-refresh').hidden=false;el('place-reviews-refresh').addEventListener('click',load);await load();
    }catch(error){el('place-reviews-status').textContent=error.message;}
});
