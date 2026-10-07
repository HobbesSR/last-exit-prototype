export function renderDevNav(mainUrl, mapgenUrl) {
  const wrapper = document.createElement('div');
  wrapper.className = 'global-tool-wrapper';

  const nav = document.createElement('nav');
  nav.className = 'global-tool-nav';

  const links = [
    { href: '/dev', text: 'Overview', match: 'dev-portal' },
    { href: '/dev/map', text: 'Macro Map', match: 'dev/map' },
    { href: '/dev/micro', text: 'Micro Maps', match: 'dev/micro' }
  ];

  let linksHtml = '';
  let currentPageName = 'Tools';
  let isMicro = location.pathname.startsWith('/dev/micro');

  for (const link of links) {
    let active = false;
    if (link.match === 'dev-portal') {
      active = location.pathname === '/dev' || location.pathname === '/dev/';
    } else {
      active = location.pathname.startsWith(link.href);
    }
    
    if (active) {
      currentPageName = link.text;
    }

    linksHtml += `<a href="${link.href}"${active ? ' class="active"' : ''}>${link.text}</a>\n`;
  }

  nav.innerHTML = `
    <div class="brand-breadcrumbs">
      <a href="/" title="Back to Game">LAST EXIT</a>
      <span class="divider">/</span>
      <span class="current-page">${currentPageName}</span>
    </div>
    <div class="links">
      ${linksHtml}
    </div>
  `;
  wrapper.appendChild(nav);

  if (isMicro) {
    const subNav = document.createElement('nav');
    subNav.className = 'app-nav';
    
    const subLinks = [
      { href: '/dev/micro', text: 'Preview Lab', exact: true },
      { href: '/dev/micro/decomposition', text: 'Decomposition', exact: true },
      { href: '/dev/micro/generation', text: 'Generation Trace', exact: true }
    ];
    
    let subLinksHtml = '';
    for (const link of subLinks) {
      const active = location.pathname === link.href || location.pathname === link.href + '/';
      subLinksHtml += `<a href="${link.href}" class="sub-tab${active ? ' active' : ''}">${link.text}</a>`;
    }
    subNav.innerHTML = subLinksHtml;
    wrapper.appendChild(subNav);
  }

  const insert = () => document.body.insertBefore(wrapper, document.body.firstChild);
  if (document.body) insert();
  else document.addEventListener('DOMContentLoaded', insert);
}

renderDevNav('', '');
