// Experimental P0 candidate. Deliberately self-contained so Node and Chrome run
// the same code. This is not a production game physics API.
const EPS = 1e-9;
const SLOP = 0.001;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const dot = (a, b) => a.x * b.x + a.y * b.y;
const cross = (a, b) => a.x * b.y - a.y * b.x;
const unit = (v, fallback = { x: 1, y: 0 }) => {
  const d = Math.hypot(v.x, v.y);
  return d > EPS ? { x: v.x / d, y: v.y / d } : fallback;
};
const rotate = (v, a) => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });
const sorted = (values) => [...values].sort((a, b) => a.id.localeCompare(b.id));
const dynamic = (b) => b.kind !== 'static';
function motorFrom(value) {
  if (value == null) return null;
  const motor = { x:value.x ?? 0, y:value.y ?? 0, accel:value.accel ?? 0 };
  if (Object.values(motor).some(v => !Number.isFinite(v)) || motor.accel < 0) throw Error('Invalid motor');
  return motor;
}
function solidPair(a, b) {
  if (a === b || (!dynamic(a) && !dynamic(b))) return false;
  if (a.kind === 'loot' || b.kind === 'loot') return !dynamic(a) || !dynamic(b);
  return true;
}
function bodyFrom(source) {
  if (!source || typeof source.id !== 'string' || !source.id || !['actor', 'prop', 'loot', 'static'].includes(source.kind)) throw Error('Invalid body');
  const b = { ...source, shape: source.shape ?? 'circle', x: source.x ?? 0, y: source.y ?? 0,
    vx: source.vx ?? 0, vy: source.vy ?? 0, angle: source.angle ?? 0, omega: source.omega ?? 0,
    mass: source.mass ?? 1, friction: source.friction ?? 0, restitution: source.restitution ?? 0,
    drag: source.drag ?? 0, sleeping: !!source.sleeping, motor: motorFrom(source.motor) };
  if (b.shape === 'circle') b.radius = source.radius ?? 8;
  else if (b.shape === 'box') { b.hx = source.hx; b.hy = source.hy; }
  else throw Error(`Unsupported shape: ${b.shape}`);
  const nums = ['x','y','vx','vy','angle','omega','mass','friction','restitution','drag', ...(b.shape === 'circle' ? ['radius'] : ['hx','hy'])];
  if (nums.some(k => !Number.isFinite(b[k])) || b.mass <= 0 || b.drag < 0 || b.friction < 0 || b.restitution < 0 ||
      (b.shape === 'circle' ? b.radius <= 0 : b.hx <= 0 || b.hy <= 0)) throw Error(`Invalid body numbers: ${b.id}`);
  b.invMass = dynamic(b) ? 1 / b.mass : 0;
  b.invI = !dynamic(b) || b.kind === 'actor' ? 0 : b.shape === 'circle' ? 2 / (b.mass * b.radius ** 2) : 3 / (b.mass * (b.hx ** 2 + b.hy ** 2));
  if (!b.invMass) { b.vx = 0; b.vy = 0; }
  if (!b.invI) b.omega = 0;
  return b;
}
function axes(b) { return [rotate({ x: 1, y: 0 }, b.angle), rotate({ x: 0, y: 1 }, b.angle)]; }
function vertices(b) {
  const [u, v] = axes(b);
  return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([sx,sy]) => ({ x: b.x + sx*b.hx*u.x + sy*b.hy*v.x, y: b.y + sx*b.hx*u.y + sy*b.hy*v.y }));
}
function support(b, n) {
  if (b.shape === 'circle') return { x: b.x + b.radius*n.x, y: b.y + b.radius*n.y };
  let best, score = -Infinity;
  for (const v of vertices(b)) { const d = dot(v,n); if (d > score) { score=d; best=v; } }
  return best;
}
function project(b, n) {
  const c = b.x*n.x + b.y*n.y;
  if (b.shape === 'circle') return [c-b.radius,c+b.radius];
  const [u,v] = axes(b), r=b.hx*Math.abs(dot(u,n))+b.hy*Math.abs(dot(v,n));
  return [c-r,c+r];
}
// A -> B normal, penetration and an approximate support-point contact.
function contact(a,b) {
  const delta={x:b.x-a.x,y:b.y-a.y};
  if (a.shape==='circle' && b.shape==='circle') {
    const d=Math.hypot(delta.x,delta.y), depth=a.radius+b.radius-d;
    if (depth < -EPS) return null;
    const n=unit(delta, a.id.localeCompare(b.id)<0 ? {x:1,y:0}:{x:-1,y:0});
    return {n,depth:Math.max(0,depth),point:{x:a.x+n.x*a.radius,y:a.y+n.y*a.radius}};
  }
  if (a.shape==='circle' && b.shape==='box') {
    const q=rotate({x:a.x-b.x,y:a.y-b.y},-b.angle);
    const cx=clamp(q.x,-b.hx,b.hx),cy=clamp(q.y,-b.hy,b.hy);
    let outward={x:q.x-cx,y:q.y-cy}, d=Math.hypot(outward.x,outward.y),depth,local;
    if (d > EPS) { depth=a.radius-d; local={x:-outward.x/d,y:-outward.y/d}; }
    else {
      const px=b.hx-Math.abs(q.x),py=b.hy-Math.abs(q.y);
      if (px<py) {local={x:q.x>=0?-1:1,y:0};depth=a.radius+px;}
      else {local={x:0,y:q.y>=0?-1:1};depth=a.radius+py;}
    }
    if (depth < -EPS) return null;
    const n=rotate(local,b.angle);
    return {n,depth:Math.max(0,depth),point:{x:a.x+n.x*a.radius,y:a.y+n.y*a.radius}};
  }
  if (a.shape==='box' && b.shape==='circle') {
    const c=contact(b,a);
    return c && {n:{x:-c.n.x,y:-c.n.y},depth:c.depth,point:c.point};
  }
  let chosen=null,depth=Infinity;
  for (const axis of [...axes(a),...axes(b)]) {
    const [al,ah]=project(a,axis),[bl,bh]=project(b,axis), overlap=Math.min(ah,bh)-Math.max(al,bl);
    if (overlap < -EPS) return null;
    if (overlap < depth) {depth=overlap;chosen=dot(delta,axis)>=0?axis:{x:-axis.x,y:-axis.y};}
  }
  const p=support(a,chosen),q=support(b,{x:-chosen.x,y:-chosen.y});
  return {n:chosen,depth:Math.max(0,depth),point:{x:(p.x+q.x)/2,y:(p.y+q.y)/2}};
}
function rayCircle(p,v,c,r) {
  const x=p.x-c.x,y=p.y-c.y,A=dot(v,v),B=2*(x*v.x+y*v.y),C=x*x+y*y-r*r;
  if (C<=0 || A<EPS) return null;
  const disc=B*B-4*A*C;
  if (disc<0) return null;
  const t=(-B-Math.sqrt(disc))/(2*A);
  if (t<0 || t>1) return null;
  return {t,n:unit({x:x+v.x*t,y:y+v.y*t})};
}
// Slab cast against expanded OBB. Rounded box corners are conservatively square.
function rayBox(p,v,b,inflateX,inflateY=inflateX) {
  const local=rotate({x:p.x-b.x,y:p.y-b.y},-b.angle),lv=rotate(v,-b.angle);
  const hx=b.hx+inflateX,hy=b.hy+inflateY;
  if (Math.abs(local.x)<hx && Math.abs(local.y)<hy) return null;
  let lo=0,hi=1,n=null;
  for (const [axis,h] of [['x',hx],['y',hy]]) {
    const s=local[axis],d=lv[axis];
    if (Math.abs(d)<EPS) {if (s < -h || s > h) return null; continue;}
    let t1=(-h-s)/d,t2=(h-s)/d,sign=-1;
    if (t1>t2) { [t1,t2]=[t2,t1];sign=1; }
    if (t1>lo) {lo=t1;n=axis==='x'?{x:sign,y:0}:{x:0,y:sign};}
    hi=Math.min(hi,t2);
    if (lo>hi) return null;
  }
  return lo>=0 && lo<=1 && n ? {t:lo,n:rotate(n,b.angle)}:null;
}
function sweep(a,b,dt) {
  const p={x:a.x,y:a.y},v={x:(a.vx-b.vx)*dt,y:(a.vy-b.vy)*dt};
  if (a.shape==='circle' && b.shape==='circle') {
    const h=rayCircle(p,v,b,a.radius+b.radius);
    return h && {t:h.t,n:{x:-h.n.x,y:-h.n.y}};
  }
  if (a.shape==='circle' && b.shape==='box') {
    const h=rayBox(p,v,b,a.radius);
    return h && {t:h.t,n:{x:-h.n.x,y:-h.n.y}};
  }
  if (a.shape==='box' && b.shape==='circle') {
    const h=rayBox({x:b.x,y:b.y},{x:-v.x,y:-v.y},a,b.radius);
    return h;
  }
  // Frozen-orientation continuous SAT for translating OBBs.
  let enter=0,leave=1,n=null;
  for (const axis of [...axes(a),...axes(b)]) {
    const [al,ah]=project(a,axis),[bl,bh]=project(b,axis),speed=dot(v,axis);
    if (Math.abs(speed)<EPS) {if (ah<bl || bh<al) return null;continue;}
    let t1=(bl-ah)/speed,t2=(bh-al)/speed,normal=speed>0?axis:{x:-axis.x,y:-axis.y};
    if (t1>t2) [t1,t2]=[t2,t1];
    if (t1>enter) {enter=t1;n=normal;}
    leave=Math.min(leave,t2);
    if (enter>leave) return null;
  }
  return n && enter>=0 && enter<=1 ? {t:enter,n}:null;
}
function velocityAt(b,p) { const rx=p.x-b.x,ry=p.y-b.y; return {x:b.vx-b.omega*ry,y:b.vy+b.omega*rx}; }
function impulsePair(a,b,p,J) {
  if (a.invMass) {a.vx-=J.x*a.invMass;a.vy-=J.y*a.invMass;a.omega-=cross({x:p.x-a.x,y:p.y-a.y},J)*a.invI;a.sleeping=false;}
  if (b.invMass) {b.vx+=J.x*b.invMass;b.vy+=J.y*b.invMass;b.omega+=cross({x:p.x-b.x,y:p.y-b.y},J)*b.invI;b.sleeping=false;}
}
function resolve(a,b,c) {
  const total=a.invMass+b.invMass;
  if (total===0) return;
  const correction=Math.max(0,c.depth-SLOP)*0.8/total;
  a.x-=c.n.x*correction*a.invMass;a.y-=c.n.y*correction*a.invMass;
  b.x+=c.n.x*correction*b.invMass;b.y+=c.n.y*correction*b.invMass;
  const p=c.point ?? {x:(a.x+b.x)/2,y:(a.y+b.y)/2};
  const va=velocityAt(a,p),vb=velocityAt(b,p),rel={x:vb.x-va.x,y:vb.y-va.y};
  const vn=dot(rel,c.n);
  if (vn>=0) return;
  const ra={x:p.x-a.x,y:p.y-a.y},rb={x:p.x-b.x,y:p.y-b.y};
  const an=cross(ra,c.n),bn=cross(rb,c.n),denom=total+an*an*a.invI+bn*bn*b.invI;
  const j=-(1+Math.max(a.restitution,b.restitution))*vn/denom;
  impulsePair(a,b,p,{x:c.n.x*j,y:c.n.y*j});
  const tangent={x:-c.n.y,y:c.n.x},vt=dot(rel,tangent);
  const at=cross(ra,tangent),bt=cross(rb,tangent),td=total+at*at*a.invI+bt*bt*b.invI;
  const jt=clamp(-vt/td,-j*Math.sqrt(a.friction*b.friction),j*Math.sqrt(a.friction*b.friction));
  impulsePair(a,b,p,{x:tangent.x*jt,y:tangent.y*jt});
}
function jointFrom(j,bodies,joints) {
  if (!j || typeof j.id!=='string' || !j.id || !['spring','rope'].includes(j.kind) || !bodies.has(j.a) || !bodies.has(j.b) || j.a===j.b || joints.has(j.id)) throw Error('Invalid joint');
  const out={...j,stiffness:j.stiffness??20,damping:j.damping??4,maxForce:j.maxForce??10000};
  if (![out.length,out.stiffness,out.damping,out.maxForce].every(Number.isFinite) || out.length<0 || out.stiffness<0 || out.damping<0 || out.maxForce<0) throw Error('Invalid joint numbers');
  return out;
}
export function createWorld(scene,options={}) {
  let disposed=false;
  const bodies=new Map(),joints=new Map();
  const settings={candidate:'bounded-custom-p0',contactIterations:options.contactIterations??8,ccdEvents:options.ccdEvents??12,
    positionSlop:SLOP,unsupported:[
      'CCD freezes box orientation within each substep; fast rotating thin boxes may tunnel',
      'circle-box swept corners use conservative square expansion and may hit early',
      'contact manifold is a single support point; long resting box stacks may jitter',
      'sleeping is metadata only; automatic sleep is unsupported',
      'mask holes, compound colliders, local joint anchors and break conditions are unsupported',
      'joint force saturation permits rope stretch beyond its commanded length',
      'CCD is capped at ccdEvents per step; exhaustion advances the remainder without a sweep',
    ]};
  if (!Number.isInteger(settings.contactIterations)||settings.contactIterations<1||!Number.isInteger(settings.ccdEvents)||settings.ccdEvents<1) throw Error('Invalid solver options');
  function live(){if(disposed) throw Error('World disposed');}
  function addBody(source){live();const b=bodyFrom(source);if(bodies.has(b.id)) throw Error(`Duplicate body ${b.id}`);bodies.set(b.id,b);return b.id;}
  function addJoint(source){live();const j=jointFrom(source,bodies,joints);joints.set(j.id,j);bodies.get(j.a).sleeping=false;bodies.get(j.b).sleeping=false;return j.id;}
  for(const b of scene.bodies??[]) addBody(b);
  for(const j of scene.joints??[]) addJoint(j);
  function bounds(b,dt) {
    let ex,ey;
    if(b.shape==='circle') ex=ey=b.radius;
    else {const [u,v]=axes(b);ex=b.hx*Math.abs(u.x)+b.hy*Math.abs(v.x);ey=b.hx*Math.abs(u.y)+b.hy*Math.abs(v.y);
      const turn=Math.min(1,Math.abs(b.omega*dt))*Math.hypot(b.hx,b.hy);ex+=turn;ey+=turn;}
    const dx=b.vx*dt,dy=b.vy*dt;
    return {left:Math.min(b.x,b.x+dx)-ex,right:Math.max(b.x,b.x+dx)+ex,
      top:Math.min(b.y,b.y+dy)-ey,bottom:Math.max(b.y,b.y+dy)+ey};
  }
  function pairs(dt=0){const arr=sorted(bodies.values()),bs=arr.map(b=>bounds(b,dt)),out=[];
    for(let i=0;i<arr.length;i++)for(let k=i+1;k<arr.length;k++)if(solidPair(arr[i],arr[k]) &&
      bs[i].left<=bs[k].right && bs[k].left<=bs[i].right && bs[i].top<=bs[k].bottom && bs[k].top<=bs[i].bottom)
      out.push([arr[i],arr[k]]);
    return out;}
  function advance(dt){for(const b of bodies.values())if(b.invMass){b.x+=b.vx*dt;b.y+=b.vy*dt;if(b.invI)b.angle+=b.omega*dt;}}
  function solveContacts(){for(let it=0;it<settings.contactIterations;it++){let any=false;for(const [a,b] of pairs()){const c=contact(a,b);if(c && (c.depth>SLOP || dot({x:b.vx-a.vx,y:b.vy-a.vy},c.n)<-EPS)){resolve(a,b,c);any=true;}}if(!any)break;}}
  function solveJoints(dt){
    for(const j of sorted(joints.values())){
      const a=bodies.get(j.a),b=bodies.get(j.b),delta={x:b.x-a.x,y:b.y-a.y},dist=Math.hypot(delta.x,delta.y);
      const n=unit(delta,a.id.localeCompare(b.id)<0?{x:1,y:0}:{x:-1,y:0});
      const stretch=dist-j.length,rel=(b.vx-a.vx)*n.x+(b.vy-a.vy)*n.y;
      const total=a.invMass+b.invMass;
      if(!total)continue;
      const J=j.kind==='rope'
        ? clamp((rel+stretch/dt)/total,0,j.maxForce*dt)
        : clamp((j.stiffness*stretch+j.damping*rel)*dt,-j.maxForce*dt,j.maxForce*dt);
      if(a.invMass){a.vx+=n.x*J*a.invMass;a.vy+=n.y*J*a.invMass;a.sleeping=false;}
      if(b.invMass){b.vx-=n.x*J*b.invMass;b.vy-=n.y*J*b.invMass;b.sleeping=false;}
    }
  }
  function step(dt){
    live();if(!Number.isFinite(dt)||dt<=0)throw Error('Invalid dt');
    for(const b of sorted(bodies.values()))if(b.invMass){
      const speed=Math.hypot(b.vx,b.vy);
      if(speed>0 && b.drag>0){const factor=Math.max(0,1-b.drag*dt/speed);b.vx*=factor;b.vy*=factor;}
      if(b.motor){const accel=b.motor.accel??0;if(!Number.isFinite(accel)||accel<0)throw Error('Invalid motor acceleration');
        const dx=(b.motor.x??0)-b.vx,dy=(b.motor.y??0)-b.vy,d=Math.hypot(dx,dy),v=Math.min(d,accel*dt);
        if(d>EPS){b.vx+=dx/d*v;b.vy+=dy/d*v;}}
    }
    solveJoints(dt);
    let left=dt;
    for(let event=0;event<settings.ccdEvents && left>EPS;event++){
      let first=null;
      for(const [a,b] of pairs(left)){
        if(contact(a,b)?.depth>SLOP)continue;
        const h=sweep(a,b,left);
        if(!h)continue;
        const rv={x:b.vx-a.vx,y:b.vy-a.vy};
        if(dot(rv,h.n)>=-EPS)continue;
        if(!first||h.t<first.h.t-EPS||(Math.abs(h.t-first.h.t)<=EPS && `${a.id}/${b.id}`<`${first.a.id}/${first.b.id}`))first={a,b,h};
      }
      if(!first){advance(left);left=0;break;}
      const travel=Math.max(0,first.h.t)*left;advance(travel);left-=travel;
      const {a,b,h}=first;
      const c=contact(a,b)??{n:h.n,depth:0,point:support(a,h.n)};
      resolve(a,b,c);
      // Progress even when a conservative cast reports an immediate hit.
      if(travel<EPS && left>EPS){const tiny=Math.min(left,dt*1e-5);advance(tiny);left-=tiny;}
    }
    if(left>EPS)advance(left);
    solveContacts();
    for(const b of bodies.values())if(![b.x,b.y,b.vx,b.vy,b.angle,b.omega].every(Number.isFinite))throw Error(`Nonfinite body ${b.id}`);
  }
  function states(){live();return sorted(bodies.values()).map(({invMass,invI,...b})=>({...b,motor:b.motor?{...b.motor}:null}));}
  function removeBody(id){live();if(!bodies.delete(id))return false;for(const [jid,j] of joints)if(j.a===id||j.b===id)joints.delete(jid);return true;}
  function removeJoint(id){live();return joints.delete(id);}
  function motor(id,value){live();const b=bodies.get(id);if(!b||!b.invMass)throw Error('Unknown dynamic body');b.motor=motorFrom(value);b.sleeping=false;}
  function impulse(id,value){live();const b=bodies.get(id);if(!b||!b.invMass)throw Error('Unknown dynamic body');if(!Number.isFinite(value.x)||!Number.isFinite(value.y))throw Error('Invalid impulse');b.vx+=value.x*b.invMass;b.vy+=value.y*b.invMass;b.sleeping=false;}
  function checkpoint(){live();return {bodies:states(),joints:sorted(joints.values()).map(j=>({...j}))};}
  function restore(cp){live();if(!cp||!Array.isArray(cp.bodies)||!Array.isArray(cp.joints))throw Error('Invalid checkpoint');
    const nextB=new Map(),nextJ=new Map();for(const source of cp.bodies){const b=bodyFrom(source);if(nextB.has(b.id))throw Error('Duplicate checkpoint body');nextB.set(b.id,b);}
    for(const source of cp.joints){const j=jointFrom(source,nextB,nextJ);nextJ.set(j.id,j);}
    bodies.clear();joints.clear();for(const [id,b] of nextB)bodies.set(id,b);for(const [id,j] of nextJ)joints.set(id,j);
  }
  function cast(q){live();const p={x:q.x,y:q.y},v={x:q.dx,y:q.dy};if(![p.x,p.y,v.x,v.y,q.radius].every(Number.isFinite)||q.radius<0)throw Error('Invalid cast');
    let first=null;for(const b of sorted(bodies.values())){if(b.kind==='loot'||b.id===q.exclude)continue;
      let inside;
      if(b.shape==='circle')inside=Math.hypot(p.x-b.x,p.y-b.y)<=q.radius+b.radius;
      else {const local=rotate({x:p.x-b.x,y:p.y-b.y},-b.angle);inside=Math.abs(local.x)<=b.hx+q.radius && Math.abs(local.y)<=b.hy+q.radius;}
      const h=inside?{t:0}:b.shape==='circle'?rayCircle(p,v,b,q.radius+b.radius):rayBox(p,v,b,q.radius);
      if(h && (!first||h.t<first.toi-EPS))first={id:b.id,toi:h.t};
    }return first;
  }
  function counts(){return {bodies:bodies.size,joints:joints.size};}
  function dispose(){if(disposed)return;bodies.clear();joints.clear();disposed=true;}
  return {settings,step,states,addBody,removeBody,addJoint,removeJoint,motor,impulse,checkpoint,restore,cast,counts,dispose};
}
