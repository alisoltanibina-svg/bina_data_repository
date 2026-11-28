// Point lookups fill the editable address; automatic values stay in memory until saved.
function PlaceAddressLookup({onEdit}) {
    const el=id=>document.getElementById(id),field=el('place-address'),cache=new Map();
    let point=null,eligible=false,wanted=false,generation=0,timer,controller,job,settle,run,lastAutomatic=null;
    function status(text){el('place-address-status').textContent=text;}
    function cancel(){
        ++generation;clearTimeout(timer);timer=null;run=null;controller?.abort();controller=null;
        settle?.();settle=null;job=null;field.removeAttribute('aria-busy');status('');
    }
    function lookup(){
        if(!point||!eligible)return;
        cancel();const request=generation,candidate={...point},key=JSON.stringify(candidate);
        status('در حال دریافت نشانی…');el('place-address-retry').hidden=true;field.setAttribute('aria-busy','true');
        job=new Promise(resolve=>{
            settle=resolve;
            run=async()=>{
                run=null;timer=null;controller=new AbortController();const active=controller,signal=active.signal;
                const timeout=setTimeout(()=>active.abort(),6500);
                try{
                    const result=cache.has(key)?{address:cache.get(key)}:await PlaceUI.api('/api/poi-explore/editor/address',{
                        method:'POST',signal,body:JSON.stringify(candidate)});
                    if(request!==generation)return;
                    if(typeof result.address!=='string'||!result.address.trim()||result.address.length>2000)throw new Error('نشانی معتبری دریافت نشد؛ می‌توانید آن را دستی وارد کنید.');
                    cache.set(key,result.address);if(cache.size>20)cache.delete(cache.keys().next().value);
                    field.value=result.address;lastAutomatic=result.address;status('نشانی را بررسی و در صورت نیاز ویرایش کنید.');
                }catch(error){
                    if(request===generation){status(error.name==='AbortError'?'دریافت نشانی طول کشید؛ می‌توانید آن را دستی وارد کنید.':error.message);el('place-address-retry').hidden=false;}
                }finally{
                    clearTimeout(timeout);
                    if(request===generation){job=null;settle=null;controller=null;field.removeAttribute('aria-busy');}
                    resolve();
                }
            };
            timer=setTimeout(run,250);
        });
    }
    field.addEventListener('input',()=>{wanted=false;cancel();lastAutomatic=null;status('');el('place-address-retry').hidden=true;onEdit(field.value);});
    el('place-address-retry').addEventListener('click',lookup);
    function clear(){cancel();point=null;eligible=wanted=false;status('');el('place-address-retry').hidden=true;}
    window.addEventListener('pagehide',clear);
    return {
        selected(candidate){
            cancel();point={...candidate};wanted=true;eligible=false;status('');el('place-address-retry').hidden=true;
            if(field.value===lastAutomatic){field.value='';lastAutomatic=null;}
        },
        validity(value){eligible=value;if(!value)cancel();else if(wanted){wanted=false;lookup();}},
        async flush(){if(run){clearTimeout(timer);const start=run;start();}if(job)await job;},
        cancel,clear,
    };
}
