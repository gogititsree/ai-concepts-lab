const SCHEMA = { type:'object', properties:{ dates:{ type:'array', items:{type:'string'} } }, required:['dates'] };
const PROMPT = 'Extract every date from this text as ISO 8601 strings. The kickoff was on 2024-03-15, the review followed on 2024-06-01, and we shipped on 2024-11-20.';
async function run(think) {
  const t0 = Date.now();
  const r = await fetch('http://localhost:11434/api/chat', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ model:'gemma4:latest', stream:false, think, format: SCHEMA,
      messages:[{role:'user', content:PROMPT}], options:{temperature:0} })
  });
  const j = await r.json();
  const ms = Date.now()-t0;
  const content = j.message?.content ?? '';
  const thinking = (j.message?.thinking ?? '').length;
  let ok=false, dates=null;
  try { const p = JSON.parse(content); ok = Array.isArray(p.dates); dates = p.dates; } catch {}
  return { ms, ok, thinking, dates, preview: content.slice(0,60).replace(/\n/g,' ') };
}
for (const think of [false, true]) {
  const results = [];
  for (let i=0;i<5;i++) results.push(await run(think));
  const okCount = results.filter(r=>r.ok).length;
  const avg = Math.round(results.reduce((a,r)=>a+r.ms,0)/results.length);
  const thinkChars = Math.round(results.reduce((a,r)=>a+r.thinking,0)/results.length);
  console.log(`think=${String(think).padEnd(5)} valid=${okCount}/5  avg=${(avg/1000).toFixed(1)}s  avg thinking chars=${thinkChars}`);
  results.forEach((r,i)=>console.log(`   run${i+1} ${r.ok?'OK ':'BAD'} ${(r.ms/1000).toFixed(1)}s  ${r.ok?JSON.stringify(r.dates):r.preview}`));
}
