(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const all = selector => [...document.querySelectorAll(selector)];
  const safeStorage = {get:key=>{try{return localStorage.getItem(key)}catch{return null}},set:(key,value)=>{try{localStorage.setItem(key,value)}catch{}}};
  let toastTimer;
  function toast(message) { const el=$('[data-toast]'); el.textContent=message; el.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.hidden=true,3200); }
  $('[data-toggle-theme]')?.addEventListener('click',()=>{ const dark=document.documentElement.dataset.theme!=='dark'; document.documentElement.dataset.theme=dark?'dark':'light'; safeStorage.set('owen-theme',dark?'dark':'light'); $('[data-toggle-theme]').setAttribute('aria-label',dark?'切換淺色模式':'切換深色模式'); });
  function setLanguage(language) {
    all('[data-language]').forEach(el=>el.hidden=el.dataset.language!==language);
    all('[data-toc-language]').forEach(el=>el.hidden=el.dataset.tocLanguage!=='all'&&el.dataset.tocLanguage!==language);
    all('[data-language-button]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.languageButton===language)));
    const title=$('[data-title-zh]'); if(title)title.textContent=language==='zh'?title.dataset.titleZh:title.dataset.titleEn;
  }
  all('[data-language-button]').forEach(button=>button.addEventListener('click',()=>setLanguage(button.dataset.languageButton)));
  function showHashLanguage() {
    let id;try{id=decodeURIComponent(location.hash.slice(1))}catch{return}
    const target=document.getElementById(id), section=target?.closest('[data-language]');
    if(section){setLanguage(section.dataset.language);requestAnimationFrame(()=>target.scrollIntoView())}
  }
  window.addEventListener('hashchange',showHashLanguage);showHashLanguage();
  all('.prose table').forEach(table=>{const wrap=document.createElement('div');wrap.className='table-scroll';wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label','可橫向捲動的表格');table.before(wrap);wrap.append(table)});
  all('.code-copy').forEach(button=>button.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(button.previousElementSibling.textContent);toast('程式碼已複製')}catch{toast('無法存取剪貼簿，請選取程式碼後複製。')}}));
  $('[data-share]')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('link[rel=canonical]').href);toast('文章連結已複製')}catch{toast('無法存取剪貼簿，請從網址列複製連結。')}});
  const search=$('[data-search-dialog]'), input=$('#site-search'),results=$('[data-search-results]'),status=$('[data-search-status]'); let searchData,searchPromise,querySequence=0;
  all('[data-open-search]').forEach(button=>button.addEventListener('click',()=>{search.showModal();input.focus()}));
  document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='k'){event.preventDefault();search.showModal();input.focus()}});
  search?.addEventListener('click',event=>{if(event.target===search){const r=search.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)search.close()}});
  input?.addEventListener('input',async()=>{
    const sequence=++querySequence,terms=input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);results.replaceChildren();
    if(!terms.length){status.textContent='輸入關鍵字，尋找一篇文章。';return}
    status.textContent='正在搜尋…';
    try{
      searchPromise ||= fetch('/search.json').then(r=>{if(!r.ok)throw Error();return r.json()}).catch(error=>{searchPromise=null;throw error});searchData ||= await searchPromise;
      if(sequence!==querySequence)return;
      const matches=searchData.filter(post=>terms.every(term=>[post.title,post.title_en,post.text,...post.tags,...post.categories].join(' ').toLowerCase().includes(term)));
      status.textContent=matches.length?`找到 ${matches.length} 篇文章。`:'沒有找到文章。試試其他詞，或縮短關鍵字。';
      for(const post of matches){const a=document.createElement('a');a.className='search-result';a.href=post.url;const title=document.createElement('strong');title.textContent=post.title;const p=document.createElement('p');p.textContent=`${post.date} · ${post.text.slice(0,110)}…`;a.append(title,p);results.append(a)}
    }catch{if(sequence===querySequence)status.textContent='暫時無法載入搜尋資料，請重新輸入關鍵字再試一次。'}
  });
  const imageDialog=$('[data-image-dialog]'); all('.prose img:not([src^="data:"])').filter(img=>!(/^(?:\d+)(?:px)?$/.test(img.getAttribute('height')||'')&&parseInt(img.getAttribute('height'),10)<=32)).forEach(img=>{img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label',`放大圖片：${img.alt||'文章圖片'}`);const open=()=>{const target=imageDialog.querySelector('img');target.src=img.src;target.alt=img.alt;imageDialog.showModal()};img.addEventListener('click',open);img.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open()}})});
  $('[data-close-image]')?.addEventListener('click',()=>imageDialog.close());imageDialog?.addEventListener('click',event=>{if(event.target===imageDialog)imageDialog.close()});
  const headings=all('.prose h2[id],.prose h3[id]');if('IntersectionObserver'in window){const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting&&!entry.target.closest('[hidden]'))all('.toc-inner nav a').forEach(a=>a.classList.toggle('active',decodeURIComponent(a.hash.slice(1))===entry.target.id))},{rootMargin:'-10% 0px -65% 0px'});headings.forEach(h=>observer.observe(h))}
  if($('.mermaid')){const script=document.createElement('script');script.src='/vendor/mermaid.min.js';script.onload=async()=>{try{mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:document.documentElement.dataset.theme==='dark'?'dark':'neutral',fontFamily:'system-ui'});await mermaid.run({nodes:all('.mermaid')})}catch{all('.mermaid:not([data-processed])').forEach(el=>el.setAttribute('aria-label','圖表無法顯示，以下保留原始描述。'))}};document.head.append(script)}
  const engagement=$('[data-engagement]');if(!engagement)return;
  const like=$('[data-like]'),likeCount=$('[data-like-count]'),likeStatus=$('[data-like-status]');let liked=null,visitorId=safeStorage.get('owen-reader-id');if(!visitorId){visitorId=crypto.randomUUID();safeStorage.set('owen-reader-id',visitorId)}
  const postPath=engagement.dataset.postPath.replace(/index\.html$/,'');const endpoint=engagement.dataset.likesEndpoint.replace(/\/$/,'');
  async function likes(method,desired){const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8000);try{const response=await fetch(endpoint+'/likes'+(method==='GET'?'?path='+encodeURIComponent(postPath):''),{method,headers:{'X-Visitor-Id':visitorId,...(method==='POST'?{'Content-Type':'application/json'}:{})},body:method==='POST'?JSON.stringify({path:postPath,liked:desired}):undefined,signal:controller.signal});if(!response.ok)throw Error('unavailable');const data=await response.json();if(!Number.isInteger(data.count)||typeof data.liked!=='boolean')throw Error();liked=data.liked;like.setAttribute('aria-pressed',String(liked));likeCount.textContent=data.count;likeStatus.textContent='';}finally{clearTimeout(timeout)}}
  if(like){likes('GET').catch(()=>{liked=null;likeStatus.textContent='目前無法確認愛心狀態，點擊後可再試一次。'}).finally(()=>like.disabled=false);like.addEventListener('click',async()=>{like.disabled=true;try{if(liked===null)await likes('GET');await likes('POST',!liked);toast(liked?'謝謝你的喜歡。':'已取消愛心。')}catch{liked=null;likeStatus.textContent='尚未確認愛心是否送出，請稍後再試；再次點擊會先確認最新狀態。'}finally{like.disabled=false}})}
  const issue=engagement.dataset.issue,repo=engagement.dataset.repo,comments=$('[data-comments]');
  if(issue&&comments){const load=async()=>{try{const response=await fetch(`https://api.github.com/repos/${repo}/issues/${issue}/comments?per_page=100`,{headers:{Accept:'application/vnd.github+json'}});if(!response.ok)throw Error();const data=await response.json();if(!data.length){comments.textContent='目前還沒有留言，歡迎開始這段對話。';return}for(const item of data){const article=document.createElement('article');article.className='comment';const header=document.createElement('a');header.className='comment-header';header.href=item.html_url;header.target='_blank';header.rel='noopener noreferrer';header.textContent=`${item.user.login} · ${new Date(item.created_at).toLocaleDateString('zh-TW')}`;const body=document.createElement('p');body.className='comment-body';body.textContent=item.body;article.append(header,body);comments.append(article)}}catch{comments.textContent='暫時無法載入留言，仍可前往 GitHub 閱讀與回覆。'}};if('IntersectionObserver'in window){const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){observer.disconnect();load()}},{rootMargin:'200px'});observer.observe(comments)}else load()}
})();
