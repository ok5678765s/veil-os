import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Veil — Full-Screen Web Viewer",
  description:
    "Browse any site in a distraction-free, full-screen view. Pages load server-side, history stays local, nothing calls out from your browser.",
  keywords: ["Veil", "full-screen browser", "web viewer", "privacy"],
  authors: [{ name: "Veil" }],
  /* favicon: the local Veil mark (src/app/icon.svg + apple-icon.png) —
     Next picks these up by file convention, so the tab shows Veil's
     shield, not the platform's default logo. */
  openGraph: {
    title: "Veil — Full-Screen Web Viewer",
    description: "The whole web, through the veil.",
    siteName: "Veil",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {/* Zone-prefix bootstrap — MUST run before any app chunk.
            When Veil is served through a path-prefix pull-zone CDN
            (…/z/<zone>/), root-relative URLs inside the JS chunks
            (fetch("/api/x"), an img.src="/wp-x.jpg", lazily-injected
            <script src="/_next/…">) resolve against the CDN origin's
            ROOT and 404 — the app shell loads but every dynamic
            request dies. This shim rewrites every client URL according
            to what the zone can carry:
              · GET/HEAD        → through the zone (cached, origin stays
                                  hidden behind the CDN front)
              · mutations       → DIRECT to the real origin (pull zones
                                  only proxy GET/HEAD) — cross-origin with
                                  permissive API CORS (token auth, no
                                  cookie reliance)
              · socket relay    → DIRECT (a fronting gateway hijacks the
                                  ?XTransformPort param before the zone
                                  ever sees it; our own gateway honors it)
            The real origin is discovered at boot from /api/cdn-target —
            a server-side constant, so no client source ever contains a
            host. On the normal origin there is no /z/ prefix and the
            whole shim is a no-op. Inline + first in <body> so it always
            wins the race with async chunk execution. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{
var m=location.pathname.match(/^\\/z\\/([A-Za-z0-9._-]+)(\\/|$)/);
if(!m)return;
var P="/z/"+m[1];
var D="";
try{
var x=new XMLHttpRequest();
x.open("GET",P+"/api/cdn-target",false);
x.send(null);
if(x.status===200){
var j=JSON.parse(x.responseText);
if(j&&typeof j.origin==="string"&&/^https:\\/\\//.test(j.origin))D=j.origin.replace(/\\/$/,"");
}
}catch(e){}
function split(s){
var h=s.match(/^[a-z][a-z0-9+.-]*:\\/\\/[^\\\/]+/i);
if(h)return{abs:true,origin:h[0],rest:s.slice(h[0].length)};
return{abs:false,origin:"",rest:s};
}
function sameOrigin(o){
return o.replace(/^ws(s?):\\/\\//i,"http$1://")===location.origin;
}
function route(u,meth){
if(typeof u!=="string"||u.length<1)return u;
var s=u;
var p=split(s);
if(p.abs){
if(!sameOrigin(p.origin))return s;
}else{
if(s.charAt(0)!=="/")return s;
if(s.charAt(1)==="/")return s;
}
var isSocket=s.indexOf("XTransformPort=")>=0;
var m2=(meth||"GET").toUpperCase();
if((isSocket||(m2!=="GET"&&m2!=="HEAD"))&&D){
return D+p.rest;
}
if(p.abs){
var qi=p.rest.indexOf("?");
var path=qi>=0?p.rest.slice(0,qi):p.rest;
var tail=qi>=0?p.rest.slice(qi):"";
var hi=path.indexOf("#");
if(hi>=0){tail=path.slice(hi)+tail;path=path.slice(0,hi);}
if(path===P||path.indexOf(P+"/")===0)return s;
return p.origin+P+path+tail;
}
if(p.rest===P||p.rest.indexOf(P+"/")===0)return s;
return P+p.rest;
}
window.__veilZone=P;
window.__veilDirect=D;
window.__veilRoute=route;
window.__veilFixUrl=function(u){return route(u,"GET");};
/* Pristine natives: the zone that serves this page injects its own
fetch/XHR wrappers FIRST (they re-route any origin-host URL back to
the zone — which kills the direct mutation/socket path with the
zone's GET-only 405). A fresh about:blank iframe gives us an
untouched realm; binding its fetch + XHR.open lets this shim route
around the injected wrappers entirely. The helper frame stays in the
DOM (removing it would tear down the realm mid-flight). */
var CF=null,CXO=null;
try{
var hf=document.createElement("iframe");
hf.setAttribute("aria-hidden","true");
hf.setAttribute("tabindex","-1");
hf.title="";
hf.style.cssText="width:0;height:0;border:0;position:fixed;left:-9999px;top:-9999px";
document.documentElement.appendChild(hf);
CF=hf.contentWindow.fetch.bind(hf.contentWindow);
CXO=hf.contentWindow.XMLHttpRequest.prototype.open;
}catch(e){}
var NAT=CF||window.fetch;
if(NAT){window.fetch=function(input,init){
try{
var meth=(init&&init.method)||(input&&input.method)||"GET";
if(typeof input==="string")input=route(input,meth);
else if(input&&typeof input.url==="string"){var u2=route(input.url,meth);if(u2!==input.url)input=new Request(u2,input);}
}catch(e){}
return NAT(input,init);
};}
if(CXO){
XMLHttpRequest.prototype.open=function(method,url){
var a=Array.prototype.slice.call(arguments);
try{a[1]=route(url,method);}catch(e){}
return CXO.apply(this,a);
};
}else{
var oo=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url){
var a=Array.prototype.slice.call(arguments);
try{a[1]=route(url,method);}catch(e){}
return oo.apply(this,a);
};
}
var OW=window.WebSocket;
if(OW){var WS=function(url,protocols){
try{
var u=route(url,"GET");
if(D&&/^https:\\/\\//i.test(u))u=u.replace(/^https:\\/\\//i,"wss://");
url=u;
}catch(e){}
return protocols===undefined?new OW(url):new OW(url,protocols);
};
WS.prototype=OW.prototype;window.WebSocket=WS;}
var owo=window.open;
if(owo){window.open=function(url,name,feats){
try{if(typeof url==="string")url=route(url,"GET");}catch(e){}
return owo.call(window,url,name,feats);
};}
var HP=window.history;
if(HP&&HP.pushState){
var ops=HP.pushState.bind(HP);
HP.pushState=function(st,title,url){try{if(typeof url==="string")url=route(url,"GET");}catch(e){}return ops(st,title,url);};
var ors=HP.replaceState.bind(HP);
HP.replaceState=function(st,title,url){try{if(typeof url==="string")url=route(url,"GET");}catch(e){}return ors(st,title,url);};
}
var sa=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(n,v){
try{
var k=String(n).toLowerCase();
if((k==="src"||k==="poster"||k==="href"||k==="data"||k==="action"||k==="formaction")&&typeof v==="string")v=route(v,"GET");
}catch(e){}
return sa.call(this,n,v);
};
function prop(ctor,name){
try{
var d=Object.getOwnPropertyDescriptor(ctor.prototype,name);
if(!d||!d.set||!d.get)return;
Object.defineProperty(ctor.prototype,name,{get:d.get,set:function(v){try{if(typeof v==="string")v=route(v,"GET");}catch(e){}d.set.call(this,v);},configurable:true});
}catch(e){}
}
prop(HTMLImageElement,"src");
prop(HTMLSourceElement,"src");
prop(HTMLVideoElement,"src");
prop(HTMLVideoElement,"poster");
prop(HTMLAudioElement,"src");
prop(HTMLIFrameElement,"src");
prop(HTMLScriptElement,"src");
prop(HTMLLinkElement,"href");
prop(HTMLAnchorElement,"href");
var OA=window.Audio;
if(OA){var A=function(src){return new OA(typeof src==="string"?route(src,"GET"):src);};A.prototype=OA.prototype;window.Audio=A;}
}catch(e){}})();`,
          }}
        />
        {children}
        {/* Hydration watchdog — a dev-server restart (or a stuck chunk
            load) can leave the SSR shell painted but React never attached:
            the page LOOKS fine yet every click is dead until a manual
            reload. This inline script waits 45s for the app to raise its
            hydrated flag (set in page.tsx's first effect); if it never
            comes, it reloads ONCE per session — the fresh load lands on
            the healthy server. (Was 15s — this page is heavy, and slow
            first loads on phones crossed 15s and reloaded mid-use, which
            read as "the site constantly reloads itself". 45s only ever
            catches genuinely dead shells.) */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{
setTimeout(function(){
if(window.__veilHydrated)return;
var k="veil:hydra-retry";
if(sessionStorage.getItem(k))return;
sessionStorage.setItem(k,"1");
location.reload();
},45000);
}catch(e){}})();`,
          }}
        />
        <Toaster />
        {/* Sonner toasts — Veil Chat (and other dynamic imports) fire these
            via `import("sonner").toast(...)`. Without this mount every one
            of them was invisible: coin gifts, purchases and profile updates
            completed silently and looked "broken". */}
        <SonnerToaster
          position="bottom-right"
          theme="dark"
          richColors
          closeButton
          toastOptions={{ duration: 4000 }}
        />
      </body>
    </html>
  );
}
