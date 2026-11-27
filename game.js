import * as THREE from "three";
import * as GameObject from "./GameObject.js";
import * as Handlers from "./Handlers.js";
import * as Dollhouse from "./Dollhouse.js";
import { getMaterials } from "./Shaders.js";

const UI_SCALE_HEIGHT = 1000;

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

    //set up materials with params from url
    const urlParams = Object.fromEntries(new URLSearchParams(window.location.search));
    const materials = getMaterials(urlParams);

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
    const far = 50;
    const camera = new THREE.PerspectiveCamera(fov, aspect, near, far);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("blue");
    camera.updateMatrixWorld();

    //set up lighting
    const ambiLight = new THREE.AmbientLight(urlParams.ambientLight ? urlParams.ambientLight : "rgb(100, 100, 100)");
    scene.add(ambiLight);
    const dirLight = new THREE.DirectionalLight(urlParams.dirLight ? urlParams.dirLight : "white", 40);
    dirLight.position.set(0.5, -0.5, 1);
    dirLight.castShadow = true;
    scene.add(dirLight);


    //handlers and managers
    const input = new Handlers.input(w, h, canvas);
    const multiplayer = new Handlers.multiplayer();
    const collision = new Handlers.collision();
    const handler = new Handlers.handler(scene, camera, ui, ghostUi, materials, input, multiplayer, collision);

    
    handleWindowResize();


    //game objects
    const activePlayer = handler.newGameObject(Dollhouse.player, { id: 0, startPos: new THREE.Vector3(0, 0, 10), isLocal: true });
    multiplayer.setControlledPlayer(0);
    handler.newGameObject(GameObject.basicCollider, { height: 2, radius: 1, bottomPos: new THREE.Vector3(0, 4, 0) });
    
    handler.newGameObject(Dollhouse.ground);


    //stress test
    /*let stressTest = true;
    addEventListener("keydown", (event) => {
        if(event.key == "1")
            stressTest = !stressTest;
    });
    setInterval(() => {
        if(!stressTest)
            return;
        activePlayer.test ??= {
            x: 0,
            y: 0,
            step: 0,
            stepLength: 1,
            turns: 0,
            dir: 0,
            dx: [1, 0, -1, 0],
            dy: [0, 1, 0, -1],
            i: 0,
            loops: Math.pow(GameObject.MAX_METERS * 2, 2),
            cellSize: 0.6,
            mm: GameObject.MAX_METERS,
        };
        const t = activePlayer.test;
        if(t.x * t.cellSize >= -t.mm && t.x * t.cellSize <= t.mm && t.y * t.cellSize >= -t.mm && t.y * t.cellSize <= t.mm)
        {
            t.i++;
            handler.newGameObject(Dollhouse.placedDoll, {
                pos: new THREE.Vector3(t.x * t.cellSize, t.y * t.cellSize, 0),
                yaw: 0,
                pose: activePlayer.pose,
                color: activePlayer.color,
                isLocal: true 
            });
        }
        t.x += t.dx[t.dir];
        t.y += t.dy[t.dir];
        t.step++;
        if(t.step == t.stepLength)
        {
            t.step = 0;
            t.dir = (t.dir + 1) % 4;
            t.turns++;
            if(t.turns % 2 == 0)
                t.stepLength++;
        }
    }, 100);
    */

    //FPS counter
    //let fpsTimer = 0;
    //let fpsCount = -1;


    //tick
    let lastTime = null;
    function tick(t = 0)
    {
        requestAnimationFrame(tick);
        lastTime ??= t;
        let dt = (t - lastTime) / 1000;
        lastTime = t;
        let time = t / 1000;


        //FPS counter
        /*fpsTimer += dt;
        fpsCount++;
        if(fpsTimer >= 1)
        {
            console.log("FPS: ", fpsCount);
            fpsCount = -1;
            fpsTimer = 0;
        }
        */
        //console.log("FPS: " + Math.round(1 / dt));


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
        
        ui.wScale = w / UI_SCALE_HEIGHT;
        ui.hScale = h / UI_SCALE_HEIGHT;
        ui.dpr = dpr;
        
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