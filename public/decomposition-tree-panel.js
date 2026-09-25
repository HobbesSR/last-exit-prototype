import { exploreDecomposition } from '/shared/map/micro/decomposition/explore.ts';

const $ = id => document.getElementById(id);
const colors = ['#54c7bb', '#6f9de0', '#d884a8', '#d7a65d', '#a18ada', '#72b777', '#dc7d66', '#70b9d8'];
const scoreLabels = { generatorFitness: 'Generator fitness', coverage: 'Assigned coverage', roomTargetCloseness: 'Room size preference', pieceComplexity: 'Piece cost', seams: 'Shared boundary cost', residualQuality: 'Residual cost', preservedHoles: 'Intact original holes', largestIntactArea: 'Largest intact piece' };
let input, inputKey, portfolio, alternativeIndex = 0, selectedId;
const nodes = root => [root, ...root.children.flatMap(nodes)];
const leaves = root => root.children.length ? root.children.flatMap(leaves) : [root];
const key = c => `${c.x},${c.y}`;
const selectedTree = () => portfolio?.alternatives[alternativeIndex];

function rows(target, entries) {
  $(target).replaceChildren(...entries.flatMap(([name, value]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = name; dd.textContent = typeof value === 'number' ? Number(value.toFixed(2)).toString() : String(value);
    return [dt, dd];
  }));
}

function renderNodes(root) {
  const render = (node, depth) => {
    const item = document.createElement('li'), button = document.createElement('button');
    button.type = 'button'; button.className = 'tree-node';
    button.classList.toggle('selected', node.id === selectedId);
    button.setAttribute('aria-pressed', String(node.id === selectedId));
    button.textContent = `${node.children.length ? '▾' : '•'} ${node.source === 'root' ? 'Region' : node.generator || node.role} · ${node.cells.length} cells`;
    button.title = `${node.id}; depth ${depth}`;
    button.addEventListener('click', () => { selectedId = node.id; renderSelection(); });
    item.append(button);
    if (node.children.length) { const list = document.createElement('ul'); list.append(...node.children.map(n => render(n, depth + 1))); item.append(list); }
    return item;
  };
  const list = document.createElement('ul'); list.append(render(root, 0)); $('tree-nodes').replaceChildren(list);
}

function draw(root, selected) {
  const canvas = $('tree-preview'), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0a1112'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const xs = root.cells.map(c => c.x), ys = root.cells.map(c => c.y), minX = Math.min(...xs), minY = Math.min(...ys);
  const w = Math.max(...xs) - minX + 1, h = Math.max(...ys) - minY + 1;
  const scale = Math.min((canvas.width - 80) / w, (canvas.height - 80) / h);
  const ox = (canvas.width - w * scale) / 2, oy = (canvas.height - h * scale) / 2;
  const project = c => ({ x: ox + (c.x - minX) * scale, y: oy + (c.y - minY) * scale });
  const selectedCells = new Set(selected.cells.map(key));
  for (const [index, leaf] of leaves(root).entries()) {
    const cells = new Set(leaf.cells.map(key));
    ctx.fillStyle = leaf.source === 'reserved' ? '#e7b95d' : leaf.source === 'forbidden' ? '#bd6570' : leaf.source === 'residual' ? '#667b93' : colors[index % colors.length];
    for (const c of leaf.cells) {
      const p = project(c); ctx.globalAlpha = selectedCells.has(key(c)) ? .9 : .2;
      ctx.fillRect(p.x, p.y, scale, scale);
      ctx.strokeStyle = '#102322'; ctx.lineWidth = .5; ctx.strokeRect(p.x, p.y, scale, scale);
    }
    ctx.globalAlpha = selectedCells.has(key(leaf.cells[0])) ? 1 : .3;
    ctx.strokeStyle = '#e6eee3'; ctx.lineWidth = 2; ctx.beginPath();
    for (const c of leaf.cells) {
      const p = project(c);
      if (!cells.has(`${c.x},${c.y - 1}`)) { ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + scale, p.y); }
      if (!cells.has(`${c.x + 1},${c.y}`)) { ctx.moveTo(p.x + scale, p.y); ctx.lineTo(p.x + scale, p.y + scale); }
      if (!cells.has(`${c.x},${c.y + 1}`)) { ctx.moveTo(p.x, p.y + scale); ctx.lineTo(p.x + scale, p.y + scale); }
      if (!cells.has(`${c.x - 1},${c.y}`)) { ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y + scale); }
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function renderSelection() {
  const tree = selectedTree(); if (!tree) return;
  const selected = nodes(tree.root).find(n => n.id === selectedId) || tree.root;
  selectedId = selected.id;
  renderNodes(tree.root);
  rows('tree-score', [['Objective score', tree.score], ['Terminal regions', leaves(tree.root).length], ...Object.entries(tree.scoreComponents).map(([name, value]) => [scoreLabels[name] || name, value])]);
  const path = [];
  function find(node) { path.push(node); if (node.id === selectedId) return true; for (const child of node.children) if (find(child)) return true; path.pop(); return false; }
  find(tree.root);
  $('tree-detail').textContent = `Depth ${path.length - 1} · ${selected.cells.length} cells · ${selected.role}. ${selected.children.length ? `Refined into ${selected.children.length} children using ${selected.plan?.strategy || 'a constrained partition'}. The parent is not also counted as terminal ownership.` : selected.stopReason || 'Retained as a terminal allocation.'}`;
  draw(tree.root, selected);
}

function regenerate() {
  if (!input) return;
  try {
    portfolio = exploreDecomposition(input, { objective: $('tree-objective').value, maxDepth: Number($('tree-depth').value), beamWidth: 4, maxExpansions: 24 });
    alternativeIndex = 0; selectedId = portfolio.alternatives[0]?.root.id;
    $('tree-alternative').replaceChildren(...portfolio.alternatives.map((tree, i) => {
      const option = document.createElement('option'); option.value = String(i);
      option.textContent = `${i + 1}. Score ${tree.score.toFixed(1)} · ${leaves(tree.root).length} terminal regions`; return option;
    }));
    $('tree-status').textContent = `${portfolio.alternatives.length} distinct retained alternatives; ${portfolio.search.expanded} expansions (limit ${portfolio.search.limit}). ${portfolio.search.budgetExhausted ? 'Search budget reached. ' : ''}Scores compare alternatives under the current objective, not across objectives. This is not exhaustive or guaranteed optimal.`;
    $('tree-download').disabled = !portfolio.alternatives.length;
    renderSelection();
  } catch (error) {
    portfolio = null; $('tree-download').disabled = true; $('tree-alternative').replaceChildren(); $('tree-nodes').replaceChildren(); $('tree-score').replaceChildren(); $('tree-detail').textContent = '';
    $('tree-preview').getContext('2d').clearRect(0, 0, 960, 620);
    $('tree-status').textContent = `Tree exploration failed: ${error.message}`;
  }
}

export function updateTreeExplorer(nextInput) {
  const nextKey = JSON.stringify(nextInput); if (inputKey === nextKey) return;
  input = structuredClone(nextInput); inputKey = nextKey; regenerate();
}
$('tree-objective').addEventListener('change', regenerate);
$('tree-depth').addEventListener('change', regenerate);
$('tree-alternative').addEventListener('change', event => { alternativeIndex = Number(event.target.value); selectedId = selectedTree().root.id; renderSelection(); });
$('tree-download').addEventListener('click', () => {
  if (!portfolio) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(portfolio, null, 2)], { type: 'application/json' })), link = document.createElement('a');
  link.href = url; link.download = `decomposition-trees-${input.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
});
window.decompositionTreeDebug = () => structuredClone({ portfolio, alternativeIndex, selectedId });
