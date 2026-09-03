import * as THREE from "three";
import * as GameObject from "./GameObject.js";
import { getMeshes } from "./Shaders.js";

window.addEventListener("load", () => {
    if("requestIdleCallback" in window)
        requestIdleCallback(loadGame);
    else
    {
        console.log("requestIdleCallback does not exist.");
        setTimeout(loadGame, 500);
    }
});

function loadGame()
{
    let dpr = window.devicePixelRatio || 1;

    //set up meshes with params from url
    const urlParams = Object.fromEntries(new URLSearchParams(window.location.search));
    const meshes = getMeshes(urlParams);

    //set up three renderer
    let w = window.innerWidth;
    let h = window.innerHeight;
    const renderer = new THREE.WebGLRenderer({
        canvas: document.getElementById("three"),
        antialias: true
    });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    //set up ui canvas
    const canvas = document.getElementById("ui");
    const ui = canvas.getContext("2d");

    //extra ui canvas with ghosting effect instead of normal drawing
    const ghostCanvas = document.getElementById("ghostui");
    const ghostUi = ghostCanvas.getContext("2d");

    //set up scene
    const fov = 70;
    const aspect = w / h;
    const near = 0.1;
    const far = 100;
    const camera = new THREE.PerspectiveCamera(fov, aspect, near, far);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("black");
    camera.updateMatrixWorld();

    //set up lighting
    const ambiLight = new THREE.AmbientLight(urlParams.ambientLight ? urlParams.ambientLight : "rgb(100, 100, 100)");
    scene.add(ambiLight);
    const dirLight = new THREE.DirectionalLight(urlParams.dirLight ? urlParams.dirLight : "white", 40);
    dirLight.position.set(1, 1, 1);
    dirLight.castShadow = true;
    scene.add(dirLight);


    //handlers and managers
    const input = new GameObject.input(w, h, dpr);
    const multiplayer = new GameObject.multiplayer();
    const handler = new GameObject.handler(scene, camera, ui, ghostUi, meshes, input, multiplayer);

    
    handleWindowResize();


    //game objects
    handler.newGameObject(GameObject.player, { id: 0, startPos: new THREE.Vector3(0, 0, 10), isLocal: true });
    multiplayer.setControlledPlayer(0);
    handler.newGameObject(GameObject.basicCollider, { height: 2, radius: 1, pos: new THREE.Vector3(0, 4, 1) });
    
    handler.newGameObject(GameObject.ground);


    //lock mouse when page is clicked
    document.addEventListener("click", (event) => {
        canvas.requestPointerLock();
    })

    //tick
    let lastTime = 0;
    function tick(t = 0)
    {
        requestAnimationFrame(tick);
        let dt = (t - lastTime) / 1000;
        lastTime = t;
        let time = t / 1000;

        if(dpr != window.devicePixelRatio)
            handleWindowResize();

        //clear previously drawn ui frame
        ui.clearRect(0, 0, w * dpr, h * dpr);
        
        //only partially clear previously drawn ui frame for ghost ui
        ghostUi.save();
        ghostUi.globalCompositeOperation = "destination-out";
        ghostUi.fillStyle = "rgba(0, 0, 0, 0.25)";
        ghostUi.fillRect(0, 0, w * dpr, h * dpr);
        ghostUi.restore();
        ghostUi.globalCompositeOperation = "source-over";
        
        multiplayer.send(dt, time);

        handler.tick(dt, time);

        renderer.render(scene, camera);
    }
    tick();

    //adapt to resized window
    function handleWindowResize()
    {
        dpr = window.devicePixelRatio;
        renderer.setPixelRatio(dpr);
        w = window.innerWidth;
        h = window.innerHeight;
        renderer.setSize(w, h);
        canvas.style.width = w + "px";
        canvas.style.height = h + "px";
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ui.setTransform(dpr, 0, 0, dpr, 0, 0);
        ui.width = w;
        ui.height = h;
        ghostCanvas.style.width = w + "px";
        ghostCanvas.style.height = h + "px";
        ghostCanvas.width = w * dpr;
        ghostCanvas.height = h * dpr;
        ghostUi.setTransform(dpr, 0, 0, dpr, 0, 0);
        ghostUi.width = w;
        ghostUi.height = h;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        input.updateScreenVars(w, h, dpr);

        document.dispatchEvent( new CustomEvent("windowResize"), { 
            detail: {
                newSize: new THREE.Vector2(w, h),
                camera: camera
            } 
        });
    }
    window.addEventListener("resize", handleWindowResize, false);
}