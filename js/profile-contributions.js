// Own-account contributions only; no client-supplied user ID or score.
onReady(() => {
    const el=id=>document.getElementById(id);
    if(!el('profile-contributions'))return;
    const number=new Intl.NumberFormat('fa-IR');let page=0,loading=false;
    const title={pending:'در انتظار بررسی',approved:'تأییدشده',rejected:'ردشده'};
    async function load(){
        if(loading)return;loading=true;
        el('profile-contributions-previous').disabled=true;el('profile-contributions-next').disabled=true;
        try{
            const response=await fetch(`${window.API_BASE_URL||''}/api/account/contributions?page=${page}`,{credentials:'include',cache:'no-store'});
            if(response.status===401){el('profile-contributions').hidden=true;const signin=el('contributions-signin');if(signin)signin.hidden=false;return;}
            const data=await response.json();if(!response.ok)throw new Error('دریافت مشارکت‌ها انجام نشد.');
            el('profile-contribution-points').textContent=number.format(data.points);
            el('profile-contribution-approved').textContent=number.format(data.summary.approved||0);
            el('profile-contribution-pending').textContent=number.format(data.summary.pending||0);
            const root=el('profile-contribution-list');root.replaceChildren();
            for(const item of data.contributions){
                const row=document.createElement('article');row.className='profile-contribution-entry';
                const heading=document.createElement('h3');const link=document.createElement('a');link.textContent=item.name;
                link.href=(typeof SITE!=='undefined'?SITE.page('locations.html'):'locations.html')+'?venue='+encodeURIComponent(item.place_id);heading.append(link);
                const status=document.createElement('span');status.className='profile-contribution-status is-'+item.status;status.textContent=title[item.status]||item.status;
                const meta=document.createElement('p');meta.textContent=(item.action==='added'?'افزودن مکان':'ویرایش مکان')+' · '+
                    (item.created_at?new Date(item.created_at).toLocaleDateString('fa-IR',{timeZone:'Asia/Tehran'}):'');
                row.append(heading,status,meta);
                if(item.can_reedit){const edit=document.createElement('a');edit.className='profile-contribution-edit';edit.textContent='ویرایش دوباره';edit.href=(typeof SITE!=='undefined'?SITE.page('place-register.html'):'place-register.html')+'?venue='+encodeURIComponent(item.place_id);row.append(edit);}
                if(item.review_note){const note=document.createElement('p');note.textContent=item.review_note;row.append(note);}
                root.append(row);
            }
            el('profile-contribution-status').textContent=data.contributions.length?'':'هنوز مشارکتی ثبت نکرده‌اید.';
            el('profile-contributions-previous').disabled=page===0;el('profile-contributions-next').disabled=!data.has_more;
        }catch(error){el('profile-contribution-status').textContent=error.message;}
        finally{loading=false;}
    }
    el('profile-contributions-previous').addEventListener('click',()=>{if(!loading&&page>0){page--;load();}});
    el('profile-contributions-next').addEventListener('click',()=>{if(!loading){page++;load();}});
    el('profile-contributions-refresh').addEventListener('click',load);
    load();
});
