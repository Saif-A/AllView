import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ExtendedInfo, PreviewContext, PreviewControls } from './extended-preview';
import { runFormatWorker } from './worker-client';

export async function renderModel(info:ExtendedInfo,bytes:Uint8Array,ctx:PreviewContext):Promise<PreviewControls>{
  if(bytes.length>16*1024*1024)throw new Error('3D models are limited to 16 MiB.');
  const ext=info.name.toLowerCase().split('.').pop();const buffer=bytes.slice().buffer;const text=()=>new TextDecoder().decode(bytes);
  const manager=new THREE.LoadingManager();manager.setURLModifier(url=>{
    if(url.startsWith('blob:')||(/^data:(application\/octet-stream|application\/gltf-buffer|image\/(png|jpeg|webp));base64,/i.test(url)&&url.length<24000000))return url;
    throw new Error('This model references external files. Only self-contained models can currently be previewed.');
  });
  let object:THREE.Object3D;
  if(ext==='ifc'){
    const result=await runFormatWorker<{meshes:{vertices:Float32Array;indices:Uint32Array;matrix:number[];color:number[]}[]}>('ifc',bytes,info.name,ctx.signal);
    const group=new THREE.Group();
    for(const part of result.meshes){const count=part.vertices.length/6,positions=new Float32Array(count*3),normals=new Float32Array(count*3);
      for(let i=0;i<count;i++){positions.set(part.vertices.subarray(i*6,i*6+3),i*3);normals.set(part.vertices.subarray(i*6+3,i*6+6),i*3);}
      const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3));geometry.setIndex(new THREE.BufferAttribute(part.indices,1));
      const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:new THREE.Color(part.color[0],part.color[1],part.color[2]),opacity:part.color[3],transparent:part.color[3]<1,side:THREE.DoubleSide}));mesh.applyMatrix4(new THREE.Matrix4().fromArray(part.matrix));group.add(mesh);
    }object=group;
  }else if(ext==='dxf'){
    const result=await runFormatWorker<{data:import('dxf-render').DxfData}>('dxf',bytes,info.name,ctx.signal);const {createThreeObjectsFromDXF}=await import('dxf-render');
    const drawing=await createThreeObjectsFromDXF(result.data,{signal:ctx.signal,darkTheme:true});object=drawing.group;
    if(drawing.unsupportedEntities?.length)ctx.notify(`Unsupported DXF entities: ${drawing.unsupportedEntities.join(', ')}`);
  }else if(ext==='stl'){
    const {STLLoader}=await import('three/addons/loaders/STLLoader.js');object=new THREE.Mesh(new STLLoader(manager).parse(buffer),new THREE.MeshStandardMaterial({color:0xb5d6c0,roughness:.65,side:THREE.DoubleSide}));
  }else if(ext==='obj'){
    const {OBJLoader}=await import('three/addons/loaders/OBJLoader.js');object=new OBJLoader(manager).parse(text());
  }else if(ext==='ply'){
    const {PLYLoader}=await import('three/addons/loaders/PLYLoader.js');const geometry=new PLYLoader(manager).parse(buffer);geometry.computeVertexNormals();
    object=geometry.index?new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:0xb5d6c0,vertexColors:geometry.hasAttribute('color'),side:THREE.DoubleSide})):new THREE.Points(geometry,new THREE.PointsMaterial({size:.02,color:0xb5d6c0,vertexColors:geometry.hasAttribute('color')}));
  }else if(ext==='glb'||ext==='gltf'){
    const {GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');const gltf=await new GLTFLoader(manager).parseAsync(ext==='glb'?buffer:text(),'');object=gltf.scene;
  }else if(ext==='fbx'){
    const {FBXLoader}=await import('three/addons/loaders/FBXLoader.js');object=new FBXLoader(manager).parse(buffer,'');
  }else if(ext==='3ds'){
    const {TDSLoader}=await import('three/addons/loaders/TDSLoader.js');object=new TDSLoader(manager).parse(buffer,'');
  }else if(ext==='3mf'){
    await runFormatWorker('unpack',bytes,info.name,ctx.signal);const {ThreeMFLoader}=await import('three/addons/loaders/3MFLoader.js');object=new ThreeMFLoader(manager).parse(buffer);
  }else if(ext==='dae'){
    if(/<!DOCTYPE|<!ENTITY/i.test(text()))throw new Error('External XML entities are not allowed in model previews.');
    const {ColladaLoader}=await import('three/addons/loaders/ColladaLoader.js');const scene=new ColladaLoader(manager).parse(text(),'')?.scene;
    if(!scene)throw new Error('This Collada file contains no scene.');object=scene;
  }else if(ext==='wrl'||ext==='vrml'){
    const {VRMLLoader}=await import('three/addons/loaders/VRMLLoader.js');object=new VRMLLoader(manager).parse(text(),'');
  }else throw new Error('A visual decoder for this model format is not implemented.');
  const disposeObject=()=>object.traverse(node=>{
    const mesh=node as THREE.Mesh;mesh.geometry?.dispose();const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];
    for(const material of materials){if(!material)continue;for(const value of Object.values(material))if(value instanceof THREE.Texture){const image=value.image as ImageBitmap|undefined;if(image&&typeof image.close==='function')image.close();value.dispose();}material.dispose();}
  });
  if(ctx.signal.aborted){disposeObject();throw new DOMException('Preview cancelled','AbortError');}
  let vertices=0;object.traverse(node=>{vertices+=(node as THREE.Mesh).geometry?.getAttribute('position')?.count??0;});
  if(vertices>2000000){disposeObject();throw new Error('This model exceeds the two-million-vertex preview limit.');}
  const box=new THREE.Box3().setFromObject(object);const size=box.getSize(new THREE.Vector3());const span=Math.max(size.x,size.y,size.z);
  if(!Number.isFinite(span)||span<=0){disposeObject();throw new Error('This model contains no viewable geometry.');}
  const normalized=new THREE.Group();normalized.add(object);normalized.scale.setScalar(3/span);normalized.position.copy(box.getCenter(new THREE.Vector3())).multiplyScalar(-3/span);
  const scene=new THREE.Scene();scene.background=new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--app-bg').trim());scene.add(normalized,new THREE.HemisphereLight(0xffffff,0x505050,3));
  const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(5,8,4);scene.add(light);
  const camera=new THREE.PerspectiveCamera(40,1,.01,1000);if(ext==='dxf')camera.position.set(0,0,6);else camera.position.set(4,3,5);
  const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'low-power'});renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=false;controls.enableRotate=ext!=='dxf';controls.target.set(0,0,0);controls.update();
  const resize=()=>{renderer.setSize(ctx.stage.clientWidth,ctx.stage.clientHeight);camera.aspect=ctx.stage.clientWidth/Math.max(1,ctx.stage.clientHeight);camera.updateProjectionMatrix();renderer.render(scene,camera);};
  ctx.stage.className='model-stage';ctx.stage.replaceChildren(renderer.domElement);const observer=new ResizeObserver(resize);observer.observe(ctx.stage);
  controls.addEventListener('change',()=>renderer.render(scene,camera));resize();
  document.addEventListener('theme-changed',()=>{scene.background=new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--app-bg').trim());renderer.render(scene,camera);},{signal:ctx.signal});
  ctx.signal.addEventListener('abort',()=>{observer.disconnect();controls.dispose();disposeObject();renderer.dispose();renderer.forceContextLoss();},{once:true});
  ctx.notify(`${vertices.toLocaleString()} vertices · Drag to orbit · Scroll to zoom`);
  return {zoom:value=>{camera.zoom=value;camera.updateProjectionMatrix();renderer.render(scene,camera);}};
}
