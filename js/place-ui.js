// Shared presentation helpers for local venue profiles, registration and review.
const PlaceUI = (() => {
    const fields=['settlement_type','operational_status','daily_congregational_prayers','has_board_of_trustees','has_imam',
        'has_basij_base','has_cultural_artistic_center','has_arts_group','has_charity_fund','has_sports_complex','has_assembly_hall','heritage_registered','is_waqf'];
    const node=(tag,text,className)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(className)n.className=className;return n;};
    const page=name=>typeof SITE!=='undefined'?SITE.page(name):name;
    const normalize=value=>String(value||'').replace(/ي/g,'ی').replace(/ك/g,'ک').replace(/[\s\u200c]+/g,' ').trim();
    async function readResponse(response,fallback='انجام درخواست ممکن نشد.'){
        let data;
        try{data=await response.json();}catch{const error=new Error(fallback);error.status=response.status;throw error;}
        if(!response.ok){
            const detail=data?.detail;
            let message=typeof detail==='string'?detail:typeof detail?.message==='string'?detail.message:fallback;
            const reference=typeof detail?.reference==='string'&&/^[a-f0-9]{16}$/i.test(detail.reference)?detail.reference:null;
            if(reference)message+=` (کد پیگیری: ${reference})`;
            const error=new Error(message);error.status=response.status;if(reference)error.reference=reference;throw error;
        }
        return data;
    }
    async function api(path,options={}) {
        const response=await fetch(`${window.API_BASE_URL||''}${path}`,{credentials:'include',cache:'no-store',...options,
            headers:{'Content-Type':'application/json','X-CSRF-Protection':'1',...(options.headers||{})}});
        return readResponse(response);
    }
    function safeLink(value){
        if(typeof value!=='string'||!value.trim())return null;let text=value.trim();if(!/^[a-z][a-z0-9+.-]*:/i.test(text))text='https://'+text;
        try{const u=new URL(text);return ['http:','https:'].includes(u.protocol)&&u.hostname&&!u.username&&!u.password?u.href:null;}catch{return null;}
    }
    function text(value){if(value==null||value==='')return 'نامشخص';if(typeof value==='boolean')return value?'بله':'خیر';
        if(Array.isArray(value))return value.map(v=>typeof v==='object'?Object.values(v).map(text).join(' · '):String(v)).join('\n');return String(value);}
    function fact(root,label,value,link=false){root.append(node('dt',label));const dd=node('dd');const url=link?safeLink(value):null;
        if(url){const a=node('a',value);a.href=url;a.target='_blank';a.rel='noopener noreferrer';dd.append(a);}else dd.textContent=text(value);root.append(dd);}
    function provinceAllowed(config,province,category='mosque'){
        const p=config.permissions;return !!(p.can_edit&&(p.all_provinces||p.provinces.some(n=>normalize(n)===normalize(province)))&&
            config.editable_categories.includes(category)&&config.coverage.categories.includes(category)&&
            config.coverage.provinces.some(row=>normalize(row.province)===normalize(province)&&row.eligible));
    }
    function definitions(config,province){const p=config.permissions,privateAccess=p.can_view_private&&(p.staff_all_provinces||p.staff_provinces?.some(name=>normalize(name)===normalize(province)));
        return config.fields.filter(f=>f.active&&(f.public||privateAccess)&&f.categories.includes('mosque')&&fields.includes(f.key)).sort((a,b)=>fields.indexOf(a.key)-fields.indexOf(b.key));}
    function photoUrl(value){return typeof value==='string'&&/^\/api\/poi-explore\/photos\/[a-f0-9-]{32,36}$/.test(value)?`${window.API_BASE_URL||''}${value}`:null;}
    return {api,readResponse,node,page,normalize,safeLink,text,fact,provinceAllowed,definitions,fields,photoUrl};
})();
