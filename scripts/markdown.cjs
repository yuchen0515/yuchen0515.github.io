const {renderMarkdown} = require('../lib/markdown.cjs');
hexo.extend.renderer.register('md', 'html', data => renderMarkdown(data.text), true);
hexo.extend.renderer.register('markdown', 'html', data => renderMarkdown(data.text), true);
