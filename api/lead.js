// Vercel Function: safe server-side relay to n8n Webhook -> Google Sheets.
// Set N8N_WEBHOOK_URL and QUIZ_WEBHOOK_SECRET in Vercel Project Settings > Environment Variables.
const AXES = ['strategy','owner','process','people','value'];
const ANSWER_VALUES = ['role','strategy','owner','process','people','value','goal'];
const ROLE_VALUES = ['owner','c','head','expert'];
const GOAL_VALUES = ['revenue','cost','speed','product','customer','unknown'];

function limited(value,max=250){return String(value ?? '').trim().slice(0,max);}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method === 'GET') {
    return res.status(200).json({
      ok:true,
      message:'Forbes Tech API available',
      n8nConfigured:Boolean(process.env.N8N_WEBHOOK_URL),
      secretConfigured:Boolean(process.env.QUIZ_WEBHOOK_SECRET)
    });
  }
  if(req.method !== 'POST') return res.status(405).json({ok:false,code:'METHOD_NOT_ALLOWED'});
  if(!String(req.headers['content-type']||'').includes('application/json')) return res.status(415).json({ok:false,code:'JSON_REQUIRED'});
  if(Number(req.headers['content-length']||0)>18000) return res.status(413).json({ok:false,code:'PAYLOAD_TOO_LARGE'});
  const url=process.env.N8N_WEBHOOK_URL;
  const secret=process.env.QUIZ_WEBHOOK_SECRET;
  if(!url || !secret) return res.status(503).json({ok:false,code:'VERCEL_ENV_MISSING'});
  try{
    const body=typeof req.body==='string' ? JSON.parse(req.body) : req.body;
    if(!body || typeof body!=='object') return res.status(400).json({ok:false,code:'INVALID_REQUEST'});
    // Honeypot: silently ignore bot submissions.
    if(limited(body.website,300)) return res.status(200).json({ok:false,code:'INVALID_SUBMISSION'});
    const raw=body.lead||{};
    const name=limited(raw.name,120);
    const company=limited(raw.company,160);
    const phone=limited(raw.phone,45);
    if(name.length<2 || phone.length<7 || !raw.privacyConsent || !/^[+\d\s()\-.]{7,45}$/.test(phone)){
      return res.status(400).json({ok:false,code:'INVALID_CONTACT_OR_CONSENT'});
    }
    const input=body.answers||{};
    const answers={};
    for(const key of ANSWER_VALUES){
      if(!input[key] || typeof input[key]!=='object') return res.status(400).json({ok:false,code:'MISSING_ANSWER_'+key});
      let value=input[key].value;
      if(AXES.includes(key)){
        if(!Number.isInteger(value) || value<0 || value>3) return res.status(400).json({ok:false,code:'INVALID_ANSWER_'+key});
      }else if(key==='role' && !ROLE_VALUES.includes(value)) return res.status(400).json({ok:false,code:'INVALID_ROLE'});
      else if(key==='goal' && !GOAL_VALUES.includes(value)) return res.status(400).json({ok:false,code:'INVALID_GOAL'});
      answers[key]={value,label:limited(input[key].label,250)};
    }
    const normalized=AXES.map(k => Math.round(answers[k].value/3*100));
    const score=Math.round(normalized.reduce((a,b)=>a+b,0)/5);
    const min=Math.min(...normalized);
    const stage=score>=85 && min>=67?'Етап масштабування':score>=65?'Сильна база':score<35?'Початковий етап':'Етап систематизації';
    const attr=body.attribution||{};
    const attribution={};
    for(const key of ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','landing_url','referrer']) attribution[key]=limited(attr[key],650);
    const submissionId=limited(body.submissionId,90);
    if(submissionId.length<10) return res.status(400).json({ok:false,code:'SUBMISSION_ID_MISSING'});
    const payload={
      submissionId,
      lead:{name,company,phone,privacyConsent:true},
      answers,
      result:{score,stage,diagnosis:limited(body.result?.diagnosis,300)},
      attribution
    };
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),8000);
    let response;
    try{
      response=await fetch(url,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({secret,payload}),
        signal:controller.signal,
        redirect:'follow'
      });
    }finally{clearTimeout(timeout);}
    if(!response.ok){
      console.error('Forbes Quiz: n8n returned HTTP status',response.status);
      return res.status(502).json({ok:false,code:'N8N_HTTP_'+response.status});
    }
    const contentType=response.headers.get('content-type')||'';
    const rawResponse=await response.text();
    let result;
    try{result=JSON.parse(rawResponse);}catch{return res.status(502).json({ok:false,code:'N8N_INVALID_RESPONSE'});}
    if(!result.ok) return res.status(502).json({ok:false,code:'N8N_REJECTED'});
    return res.status(200).json({ok:true});
  }catch(err){
    console.error('Forbes Quiz: webhook request failed:',err?.name||'Error');
    const isTimeout = err?.name === 'AbortError';
    return res.status(502).json({ok:false,code:isTimeout ? 'N8N_TIMEOUT' : 'N8N_NETWORK_ERROR'});
  }
}
