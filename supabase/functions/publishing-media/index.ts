import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { json, preflight, check, uuid, webpDimensions } from '../_shared/photo-v2.ts';
Deno.serve(async(req: Request)=>{
 if(req.method==='OPTIONS')return preflight();
 if(req.method!=='POST')return json({error:'POST required'},405);
 try{
  const url=Deno.env.get('SUPABASE_URL')!,anon=Deno.env.get('SUPABASE_ANON_KEY')!,key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const token=req.headers.get('authorization')||'';
  const user=createClient(url,anon,{global:{headers:{Authorization:token}},auth:{persistSession:false}});
  const identity=await user.auth.getUser();if(identity.error||!identity.data.user)return json({error:'Sign in required'},401);
  const access=await user.rpc('snh_member_has_publishing_access');if(access.error||access.data!==true)return json({error:'Publishing access required'},403);
  const admin=createClient(url,key,{auth:{persistSession:false}});
  async function rpc(name:string,args:Record<string,unknown>={}){const r=await user.rpc(name,args);check(r);return r.data;}
  const multipart=req.headers.get('content-type')?.startsWith('multipart/form-data');
  if(multipart){
   // Bound multipart input before parsing it. This limit also applies to chunked requests.
   const reader=req.body!.getReader();let total=0;const chunks:Uint8Array[]=[];
   for(;;){const r=await reader.read();if(r.done)break;total+=r.value.length;if(total>18*1024*1024){await reader.cancel();throw new Error('Upload is too large');}chunks.push(r.value);}
   const bytes=new Uint8Array(total);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
   const form=await new Request(req.url,{method:'POST',headers:{'content-type':req.headers.get('content-type')!},body:bytes}).formData();
   const files:Record<string,Uint8Array>={};
   for(const name of ['web','thumb']){
    const file=form.get(name);if(!(file instanceof File)||file.size<1||file.size>8388608)throw new Error('Choose a converted WebP image');
    const data=new Uint8Array(await file.arrayBuffer()),dim=webpDimensions(data);
    if(Math.max(dim.width,dim.height)>(name==='web'?1920:640))throw new Error('Image dimensions exceed the library limit');files[name]=data;
   }
   const image=await rpc('snh_publishing_image_write',{p_action:'reserve',p_title:form.get('title'),p_alt:form.get('alt')});
   // Known immutable paths allow a failed upload to be cleaned up from the library.
   for(const name of ['web','thumb'])check(await admin.storage.from('publishing-private').upload(`${image.id}/${name}.webp`,files[name],{contentType:'image/webp',upsert:false}));
   return json({image:await rpc('snh_publishing_image_write',{p_action:'finish',p_id:image.id})});
  }
  async function publishedImageExists(id:string){const r=await admin.storage.from('publishing-public').list(id,{search:'web.webp'});check(r);return r.data?.some((item:any)=>item.name==='web.webp');}
  const body=await req.json();
  if(body.action==='library'){
   const images=await rpc('snh_publishing_images');
   for(const image of images){if(image.state==='ready'){const r=await admin.storage.from('publishing-private').createSignedUrl(`${image.id}/thumb.webp`,600);check(r);image.preview=r.data!.signedUrl;}}
   return json({images});
  }
  if(body.action==='publish'){
   const id=uuid(body.id),entries=await rpc('snh_publishing_activities');const entry=entries.find((e:any)=>e.id===id);
   if(!entry||entry.version!==body.version)throw new Error('Activity changed. Reopen it before publishing.');
   if(entry.archived)throw new Error('Restore before publishing');
   await rpc('snh_publishing_activity_write',{p_action:'prepare_image',p_id:id,p_version:body.version});
   if(entry.draft.image_id){
    const imageId=uuid(entry.draft.image_id);const images=await rpc('snh_publishing_images');
    if(!images.some((i:any)=>i.id===imageId&&i.state==='ready'))throw new Error('Image is unavailable');
    const existing=await publishedImageExists(imageId);
    if(!existing){
     const source=await admin.storage.from('publishing-private').download(`${imageId}/web.webp`);check(source);
     const data=new Uint8Array(await source.data!.arrayBuffer());webpDimensions(data);
     const uploaded=await admin.storage.from('publishing-public').upload(`${imageId}/web.webp`,data,{contentType:'image/webp',upsert:false});
     // Two publishers may prepare a reused image concurrently. Verify the immutable object exists.
     if(uploaded.error){const retry=await publishedImageExists(imageId);if(!retry)check(uploaded);}
    }
   }
   return json({entry:await rpc('snh_publishing_activity_write',{p_action:'publish',p_id:id,p_version:body.version})});
  }
  if(body.action==='remove'){
   const id=uuid(body.id);await rpc('snh_publishing_image_write',{p_action:'remove',p_id:id});
   check(await admin.storage.from('publishing-private').remove([`${id}/web.webp`,`${id}/thumb.webp`]));
   check(await admin.storage.from('publishing-public').remove([`${id}/web.webp`]));
   await rpc('snh_publishing_image_write',{p_action:'removed',p_id:id});return json({removed:true});
  }
  return json({error:'Unknown media action'},400);
 }catch(e){return json({error:e instanceof Error?e.message:'Publishing image operation failed'},400);}
});
