const MarkdownIt = require('markdown-it');
const anchor = require('markdown-it-anchor');
const {katex} = require('@mdit/plugin-katex');
const hljs = require('highlight.js');
const {slugize} = require('hexo-util');
const cheerio = require('cheerio');
const fs = require('node:fs');
const path = require('node:path');
const iconCache = new Map();

function finish(html) {
  const $ = cheerio.load(html, null, false);
  const ids = new Set($('[id]').map((i, el) => $(el).attr('id')).get());
  $('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]').each((i, el) => {
    const heading = $(el), id = heading.attr('id');
    const prefix = id.startsWith('en-') ? 'en-' : '';
    const legacy = prefix + slugize(heading.text().replace(/&/g,'&amp;').replace(/--/g,'—'));
    for (const alias of [legacy, ...(prefix ? [legacy.slice(3), id.slice(3)] : [])]) {
      if (!alias || ids.has(alias)) continue;
      heading.before($('<span class="anchor-alias" aria-hidden="true"></span>').attr('id',alias));
      ids.add(alias);
    }
  });
  $('a[href]').each((i,el)=>{if($(el).attr('href')==='https://www.the-qrcode-generator.com://www.the-qrcode-generator.com/')$(el).attr('href','https://www.the-qrcode-generator.com/');});
  $('img[height]').each((i,el)=>{if (/^\d+(?:px)?$/.test($(el).attr('height')) && parseInt($(el).attr('height'),10)<=32) $(el).addClass('inline-logo');});
  $('img[alt]').each((i,el)=>{if (/^(?:NTU|NTNU|YLSH) Logo$/i.test($(el).attr('alt'))) $(el).addClass('school-logo');});
  $('img').each((i,el)=>{if($(el).attr('src')==='https://upload.wikimedia.org/wikipedia/zh/thumb/c/c3/National_Taiwan_Normal_University_logo.svg/200px-National_Taiwan_Normal_University_logo.svg.png')$(el).attr('src','/images/logos/ntnu.png');});
  $('i[class]').each((i,el)=>{
    const cls=$(el).attr('class'), name=/message/.test(cls)?'mail':/collection-tag/.test(cls)?'tag':/github/.test(cls)?'github':/linkedin/.test(cls)?'linkedin':null;
    if(!name)return;
    if(!iconCache.has(name))iconCache.set(name,fs.readFileSync(path.join(__dirname,'../node_modules/lucide-static/icons',name+'.svg'),'utf8').replace('<svg','<svg class="icon legacy-icon" aria-hidden="true" focusable="false"'));
    $(el).replaceWith(iconCache.get(name));
  });
  return $.html();
}

function parser(language = '') {
  const md = new MarkdownIt({html: true, linkify: true, breaks: false,
    highlight(code, language) {
      if (language && hljs.getLanguage(language)) return hljs.highlight(code, {language, ignoreIllegals: true}).value;
      return md.utils.escapeHtml(code);
    }
  }).use(katex, {throwOnError: false, errorColor: '#aa3333', trust: false})
    .use(anchor, {slugify: title => (language === 'en' ? 'en-' : '') + slugize(title), level: [1,2,3,4,5,6]});
  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, index, options, env, self) => {
    if (tokens[index].info.trim() === 'mermaid') return `<pre class="mermaid">${md.utils.escapeHtml(tokens[index].content)}</pre>\n`;
    return `<div class="code-block">${fence(tokens, index, options, env, self)}<button class="code-copy" type="button" aria-label="複製程式碼">複製</button></div>\n`;
  };
  const image = md.renderer.rules.image;
  md.renderer.rules.image = (tokens,index,options,env,self) => {
    tokens[index].attrSet('loading','lazy');
    tokens[index].attrSet('decoding','async');
    return image(tokens,index,options,env,self);
  };
  const link = md.renderer.rules.link_open || ((tokens,index,options,env,self)=>self.renderToken(tokens,index,options));
  md.renderer.rules.link_open = (tokens,index,options,env,self) => {
    if (/^https?:\/\//i.test(tokens[index].attrGet('href') || '')) tokens[index].attrSet('rel','noopener noreferrer');
    return link(tokens,index,options,env,self);
  };
  return md;
}

function languageParts(source) {
  const sections = [...source.matchAll(/<!--\s*LANG:(ZH|EN) START\s*-->([\s\S]*?)<!--\s*LANG:\1 END\s*-->/g)];
  if (!sections.length) { if(/<!--\s*LANG:/.test(source)) throw new Error('雙語標記缺少配對，請檢查 LANG START／END。'); return null; }
  // Fail explicitly when delimiters drift; never silently drop authored text.
  const markerCount = [...source.matchAll(/<!--\s*LANG:(?:ZH|EN) (?:START|END)\s*-->/g)].length;
  if (markerCount !== sections.length * 2) throw new Error('雙語標記缺少配對，請檢查 LANG START／END。');
  if (sections.some((s,i)=>sections.findIndex(t=>t[1]===s[1]) !== i)) throw new Error('雙語區塊重複，請檢查 LANG 標記。');
  const parts=[]; let cursor=0;
  for(const section of sections){if(source.slice(cursor,section.index).trim())parts.push({language:'all',source:source.slice(cursor,section.index)});parts.push({language:section[1].toLowerCase(),source:section[2]});cursor=section.index+section[0].length;}
  if(source.slice(cursor).trim())parts.push({language:'all',source:source.slice(cursor)});
  return parts;
}

function renderMarkdown(source) {
  const sections = languageParts(source);
  if (!sections) return finish(parser().render(source));
  const first = sections.find(s=>s.language === 'zh')?.language || sections[0].language;
  return finish(sections.map(({language,source}) => language==='all' ? parser().render(source) : `<section class="language-version" data-language="${language}" lang="${language === 'zh' ? 'zh-Hant' : 'en'}"${language === first ? '' : ' hidden'}>${parser(language).render(source)}</section>`).join('\n'));
}
module.exports = {renderMarkdown, languageParts};
