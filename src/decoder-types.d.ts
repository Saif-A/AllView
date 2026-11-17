declare module 'djvujs-dist/library/src/DjVuDocument' {
  interface DjVuBookmark {description:string;url:string;children?:DjVuBookmark[]}
  interface DjVuPage {
    getWidth():number;
    getHeight():number;
    getImageData(rotate?:boolean):ImageData;
    reset():void;
  }
  export default class DjVuDocument {
    constructor(buffer:ArrayBuffer,options?:{baseUrl?:string|null;memoryLimit?:number});
    isBundled():boolean;
    getPagesQuantity():number;
    getPage(number:number):Promise<DjVuPage>;
    getContents():DjVuBookmark[]|null;
    getPageNumberByUrl(url:string):number|null;
  }
}
declare module 'process' {
  const process:{browser:boolean;env:Record<string,string|undefined>;version:string;nextTick:(callback:(...args:unknown[])=>void,...args:unknown[])=>void};
  export default process;
}
