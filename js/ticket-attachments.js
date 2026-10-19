// Private image attachments; filenames and server messages are never interpreted as HTML.
(() => {
    'use strict';
    const MAX_SIZE = 3 * 1024 * 1024, MAX_FILES = 3;
    const sizeText = size => size >= 1024*1024 ? (size/1024/1024).toLocaleString('fa-IR',{maximumFractionDigits:1})+' مگابایت' : Math.max(1,Math.ceil(size/1024)).toLocaleString('fa-IR')+' کیلوبایت';
    const api = (path, options) => apiFetch(API_BASE_URL + path, Object.assign({credentials:'include',cache:'no-store'},options));
    async function responseError(response) {
        const data = await response.json().catch(() => ({}));
        const detail = data.detail || {};
        return Object.assign(new Error(detail.message || 'بارگذاری پیوست ممکن نشد.'), {code:detail.code});
    }
    function uploadError(status, data) {
        const detail = data && typeof data.detail === 'object' ? data.detail : {};
        if (typeof detail?.message === 'string' && detail.message) return detail.message;
        const messages = {
            401: 'نشست شما پایان یافته است. دوباره وارد حساب شوید.',
            403: 'اجازه بارگذاری صادر نشد. صفحه را تازه‌سازی کنید و دوباره تلاش کنید.',
            404: 'سرویس بارگذاری در دسترس نیست. لطفاً موضوع را به پشتیبانی اطلاع دهید.',
            405: 'سرویس بارگذاری در دسترس نیست. لطفاً موضوع را به پشتیبانی اطلاع دهید.',
            413: 'سرور بارگذاری این تصویر را به‌دلیل محدودیت حجم نپذیرفت. تصویر کوچک‌تری انتخاب کنید یا به پشتیبانی اطلاع دهید.',
            429: 'تعداد درخواست‌های بارگذاری زیاد است. کمی بعد دوباره تلاش کنید.',
            502: 'ارتباط با سرویس بارگذاری برقرار نشد. کمی بعد دوباره تلاش کنید.',
            503: 'سرویس بارگذاری موقتاً در دسترس نیست. کمی بعد دوباره تلاش کنید.',
            504: 'پاسخ سرویس بارگذاری بیش از حد طول کشید. دوباره تلاش کنید.'
        };
        return (messages[status] || 'بارگذاری تصویر به‌دلیل خطای سرور انجام نشد. لطفاً به پشتیبانی اطلاع دهید.') + ' (' + status + ')';
    }
    function create(container, reference = () => '') {
        if (!container) return null;
        let entries = [], disabled = false, uploading = false, waitUntil = 0;
        const label = document.createElement('label'); label.className = 'ticket-file-picker';
        const clip = document.createElementNS('http://www.w3.org/2000/svg','svg');
        clip.setAttribute('viewBox','0 0 24 24');clip.setAttribute('fill','none');clip.setAttribute('stroke','currentColor');clip.setAttribute('stroke-width','1.8');clip.setAttribute('aria-hidden','true');
        const path = document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9a2 2 0 0 1 3 3l-9 9');clip.append(path);
        const caption = document.createElement('span');caption.textContent='افزودن تصویر';
        const input = document.createElement('input');input.type='file';input.multiple=true;input.accept='.jpg,.jpeg,.png,.webp';input.setAttribute('aria-label','انتخاب تصاویر پیوست');
        label.append(clip,caption,input);
        const hint = document.createElement('small');hint.className='ticket-file-hint';hint.textContent='JPG، PNG یا WebP · حداکثر ۳ تصویر، هر تصویر ۳ مگابایت · پیوست‌ها سه ماه پس از بسته‌شدن تیکت حذف می‌شوند.';
        const list = document.createElement('ul');list.className='ticket-file-list';
        const notice = document.createElement('p');notice.className='ticket-file-error';notice.setAttribute('role','alert');notice.hidden=true;
        container.append(label,hint,list,notice);
        function fail(message) {notice.textContent=message;notice.hidden=false;}
        function discard(entry) {
            URL.revokeObjectURL(entry.preview);
            if (entry.id) api('/api/account/ticket-attachments/'+entry.id,{method:'DELETE'}).catch(()=>{});
        }
        function render() {
            list.replaceChildren();input.disabled=disabled||uploading;
            for (const entry of entries) {
                const item=document.createElement('li');
                const image=document.createElement('img');image.src=entry.preview;image.alt='پیش‌نمایش تصویر انتخاب‌شده';
                const text=document.createElement('span');text.textContent=entry.file.name+' · '+sizeText(entry.file.size);
                const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','حذف '+entry.file.name);remove.disabled=disabled||uploading;
                remove.onclick=()=>{entries=entries.filter(file=>file!==entry);discard(entry);render();};
                const progress=document.createElement('progress');progress.max=100;progress.value=entry.progress||0;progress.hidden=!uploading;progress.setAttribute('aria-label','پیشرفت بارگذاری '+entry.file.name);entry.bar=progress;
                item.append(image,text,remove,progress);list.append(item);
            }
        }
        input.onchange=()=>{
            notice.hidden=true;
            for (const file of input.files) {
                if (entries.length>=MAX_FILES) {fail('برای هر پیام حداکثر سه تصویر انتخاب کنید.');break;}
                if (!/\.(jpe?g|png|webp)$/i.test(file.name)||!file.size||file.size>MAX_SIZE) {fail('فقط تصویر JPG، PNG یا WebP با حجم حداکثر ۳ مگابایت انتخاب کنید.');continue;}
                entries.push({file,preview:URL.createObjectURL(file),id:'',progress:0});
            }
            input.value='';render();
        };
        function uploadOne(entry) {
            return new Promise((resolve,reject)=>{
                const xhr=new XMLHttpRequest();xhr.open('POST',API_BASE_URL+'/api/account/ticket-attachments');xhr.withCredentials=true;xhr.timeout=30000;
                xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.setRequestHeader('X-CSRF-Protection','1');xhr.setRequestHeader('X-Upload-Filename',encodeURIComponent(entry.file.name));
                const target=reference();if(target)xhr.setRequestHeader('X-Ticket-Reference',target);
                xhr.upload.onprogress=event=>{if(event.lengthComputable){entry.progress=Math.round(event.loaded/event.total*100);if(entry.bar)entry.bar.value=entry.progress;}};
                xhr.onerror=xhr.ontimeout=()=>reject(new Error('بارگذاری تصویر کامل نشد؛ متن و فایل‌های انتخاب‌شده حفظ شده‌اند. دوباره تلاش کنید.'));
                xhr.onload=()=>{
                    let data={};try{data=JSON.parse(xhr.responseText);}catch(_){}
                    if(xhr.status<200||xhr.status>=300){const seconds=Number(xhr.getResponseHeader('Retry-After')||0);if(seconds>0)waitUntil=Date.now()+seconds*1000;reject(Object.assign(new Error(uploadError(xhr.status,data)),{code:data.detail?.code}));return;}
                    if(!/^[0-9a-f]{32}$/.test(data.id||'')){reject(new Error('پاسخ بارگذاری معتبر نیست.'));return;}
                    entry.id=data.id;entry.progress=100;resolve(entry.id);
                };
                xhr.send(entry.file);
            });
        }
        return {
            hasFiles:()=>entries.length>0,
            setDisabled(value){disabled=!!value;render();},
            async upload(){
                if(disabled)throw new Error('افزودن پیوست به این گفتگو مجاز نیست.');
                if(entries.length && Date.now()<waitUntil)throw new Error('برای بارگذاری دوباره '+Math.ceil((waitUntil-Date.now())/1000)+' ثانیه صبر کنید.');
                uploading=true;notice.hidden=true;render();
                try{const ids=[];for(const entry of entries)ids.push(entry.id||await uploadOne(entry));return ids;}
                catch(error){fail(error.message);error.inlineDisplayed=true;throw error;}
                finally{uploading=false;render();}
            },
            reset(){for(const entry of entries)URL.revokeObjectURL(entry.preview);entries=[];notice.hidden=true;render();},
            clear(){for(const entry of entries)discard(entry);entries=[];notice.hidden=true;render();}
        };
    }
    function render(parent, files, objectUrls) {
        if (!files?.length) return;
        const list=document.createElement('div');list.className='ticket-message-files';
        for(const file of files){
            if(!/^[0-9a-f]{32}$/.test(file.id||''))continue;
            const card=document.createElement('div');card.className='ticket-message-file';
            const name=document.createElement('span');name.textContent=file.name;
            const preview=document.createElement('button');preview.type='button';preview.textContent='نمایش تصویر';
            const download=document.createElement('button');download.type='button';download.textContent='دریافت';
            let blobUrl='',image=null;
            async function load(){
                if(blobUrl)return blobUrl;
                const response=await api('/api/account/ticket-attachments/'+file.id);
                if(!response.ok)throw await responseError(response);
                const blob=await response.blob();
                if(blob.type!=='image/webp')throw new Error('قالب تصویر معتبر نیست.');
                const value=URL.createObjectURL(blob);
                if(!parent.isConnected){URL.revokeObjectURL(value);throw new Error('گفتگو تغییر کرده است.');}
                blobUrl=value;objectUrls.push(value);return value;
            }
            async function action(button,fn){button.disabled=true;try{await fn();}catch(error){name.textContent=file.name+' · '+error.message;}finally{button.disabled=false;}}
            preview.onclick=()=>action(preview,async()=>{if(image){image.hidden=!image.hidden;return;}const url=await load();image=document.createElement('img');image.alt='تصویر پیوست';image.src=url;card.append(image);});
            download.onclick=()=>action(download,async()=>{const link=document.createElement('a');link.href=await load();link.download='attachment-'+file.id.slice(0,8)+'.webp';document.body.append(link);link.click();link.remove();});
            card.append(name,preview,download);list.append(card);
        }
        parent.append(list);
    }
    window.TicketAttachments={create,render,revoke(urls){for(const url of urls.splice(0))URL.revokeObjectURL(url);}};
})();
