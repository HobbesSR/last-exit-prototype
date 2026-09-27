export function renderDevNav(mainUrl, mapgenUrl) {
  const nav = document.createElement('nav');
  nav.className = 'global-tool-nav';
  
  const links = [];
  if (mainUrl) {
    links.push({ href: `${mainUrl}/micro-lab.html`, text: 'Micro Lab', match: 'micro-lab' });
    links.push({ href: `${mainUrl}/decomposition-lab.html`, text: 'Decomposition', match: 'decomposition' });
    links.push({ href: `${mainUrl}/generation-demo.html`, text: 'Demo', match: 'generation' });
  }
  if (mapgenUrl) {
    links.push({ href: `${mapgenUrl}/`, text: 'Map Lab', match: 'mapgen' });
  }

  let linksHtml = '';
  for (const link of links) {
    let active = false;
    if (link.match === 'mapgen') {
      active = location.port === new URL(mapgenUrl).port;
    } else {
      active = location.pathname.includes(link.match);
    }
    const target = (link.match === 'mapgen' && !active) ? ' target="_blank"' : '';
    const arrow = (link.match === 'mapgen' && !active) ? ' &nearr;' : '';
    linksHtml += `<a href="${link.href}"${active ? ' class="active"' : ''}${target}>${link.text}${arrow}</a>\n`;
  }

  const brandUrl = mainUrl ? `${mainUrl}/` : '/';
  
  nav.innerHTML = `
    <div class="brand"><a href="${brandUrl}" class="home-link">LAST <b>EXIT</b></a> <span class="divider">/</span> <span>DEVELOPMENT TOOLS</span></div>
    <div class="links">
      ${linksHtml}
    </div>
  `;
  const insert = () => document.body.insertBefore(nav, document.body.firstChild);
  if (document.body) insert();
  else document.addEventListener('DOMContentLoaded', insert);
}
