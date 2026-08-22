import * as THREE from "three";
import { GLTFLoader } from "jsm/loaders/GLTFLoader.js";

const modelLoader = new GLTFLoader();

const uiScaleHeight = 1000;

let dpr = window.devicePixelRatio || 1;

function lerp(vec1, vec2, t)
{
    const a = vec1.clone();
    const b = vec2.clone();
    return a.add( b.sub(a).multiplyScalar(t) );
}

function trimVector3(vec3) { return { x: vec3.x, y: vec3.y, z: vec3.z }; }
function trimVector2(vec2) { return { x: vec2.x, y: vec2.y }; }
function untrimData(data)
{
    const x = Object.hasOwn(data, 'x');
    const y = Object.hasOwn(data, 'y');
    const z = Object.hasOwn(data, 'z');
    if(x && y && z)
        return new THREE.Vector3(data.x, data.y, data.z);
    else if(x && y)
        return new THREE.Vector2(data.x, data.y);
    
    return data;
}

function worldToScreen(vector3, camera, screenWidth, screenHeight)
{
    const screenPos = vector3.clone().project(camera);
    return new THREE.Vector2((1.0 + screenPos.x) * screenWidth / 2, (1.0 - screenPos.y) * screenHeight / 2);
}

export class handler
{
    gameObjects = [];
    localGameObjects = [];
    nonLocalGameObjects = [];
    removeGameObjects = [];
    unshiftGameObjects = []; //used for adding gameObjects to the start of the list, useful for affecting draw order for ui
    tagGroups = {};
    meshes = {};
    camera = null;
    inputManager = null;
    gameState = null;
    constructor(scene, camera, ui, ghostUi, meshes, inputManager, gameState)
    {
        this.scene = scene;
        this.ui = ui;
        this.ghostUi = ghostUi;
        this.meshes = meshes;
        this.camera = camera;
        this.inputManager = inputManager;
        this.gameState = gameState;

        //preload meshes and keep in memory to prevent lag spikes on spawns
        for(const [key, mesh] of Object.entries(meshes))
        {
            const copy = mesh.clone();
            copy.scale.setScalar(0);
            scene.add(copy);
        }


    }
    addTag(gameObj, str)
    {
        if(!gameObj.tags.includes(str))
            gameObj.tags.push(str);
        
        if(!this.tagGroups[str])
            this.tagGroups[str] = [gameObj];
        else
            this.tagGroups[str].push(gameObj);
    }
    getGroupByTag(str)
    {
        if(!!this.tagGroups[str])
            return this.tagGroups[str];
        else
            return [];
    }
    newGameObject(gameObjClass, args = {}, under = false)
    {
        const gameObj = new gameObjClass({ ...args, handler: this });
        this.addGameObject(gameObj, under);
        return gameObj;
    }
    addGameObject(gameObj, under = false)
    {
        gameObj.handler = this;
        gameObj.ui = this.ui;
        gameObj.ghostUi = this.ghostUi;

        if(gameObj.isLocal)
            this.localGameObjects.push(gameObj);
        else
            this.nonLocalGameObjects.push(gameObj);
        
        if(gameObj.mesh)
            this.scene.add(gameObj.mesh);

        if(under)
            this.unshiftGameObjects.push(gameObj);
        else
            this.gameObjects.push(gameObj);
    }
    removeGameObject(gameObj) { this.removeGameObjects.push(gameObj); }
    removeMesh(mesh)
    {
        if(!mesh)
            return;
        this.scene.remove(mesh);
    }
    tick(dt, time)
    {
        for(const go of this.gameObjects)
        {
            go.tick(dt, time);
        }
        for(const go of this.nonLocalGameObjects)
        {
            go.catchUp(dt, time);
        }

        for(const rgo of this.removeGameObjects)
        {
            this.removeMesh(rgo.mesh);
            for(const tag of rgo.tags)
            {
                const rgoInd = this.tagGroups[tag].indexOf(rgo);
                this.tagGroups[tag].splice(rgoInd, 1);
            }
        }
        this.gameObjects = this.gameObjects.filter(e => !this.removeGameObjects.includes(e));
        this.removeGameObjects = [];

        for(const ugo of this.unshiftGameObjects)
        {
            this.gameObjects.unshift(ugo);
        }
        this.unshiftGameObjects = [];
    }
    send(action)
    {
        for(const go of this.localGameObjects)
        {
            go.send(action);
        }
    }
    setLocal(gameObj, isLocal)
    {
        const getArr = (local) => { return (local ? this.localGameObjects : this.nonLocalGameObjects) };
        
        const arr = getArr(gameObj.isLocal);
        arr.splice(arr.indexOf(gameObj), 1);
        
        gameObj.isLocal = isLocal;
        getArr(isLocal).push(gameObj);
    }
}

//abstract base class, should never be created
export class gameObject extends EventTarget
{
    handler = null;
    pos = new THREE.Vector3();
    tags = [];
    isLocal = true;
    sendingData = {};
    catchUpData = {};
    constructor(mesh = null, isLocal = true)
    {
        super();
        this.mesh = mesh ? mesh.clone() : null;
        this.isLocal = isLocal;
    }
    tick(dt, time)
    {
        //automatically set any uTime uniforms on materials of meshes

        if(!this.mesh)
            return;

        this.mesh.traverse((mesh) => {
            let uTime = mesh.material?.userData?.shader?.uniforms?.uTime;
            if(!uTime)
                uTime = mesh.material?.uniforms?.uTime;
            if(!!uTime)
                uTime.value = time;
        });
    }
    addSendingData(name, getter, catchUp)
    {
        this.sendingData[name] = { getter: getter };
        this.catchUpData[name] = { catchUp: catchUp, caughtUp: true, target: null, start: null };
    }
    receiveCatchUpData(name, target)
    {
        const cud = this.catchUpData[name];
        cud.caughtUp = false;
        cud.target = untrimData(target);
        cud.start = untrimData(this.sendingData[name].getter());
    }
    catchUp(dt, time)
    {
        for(const [key, data] of Object.entries(this.catchUpData))
        {
            if(data.caughtUp)
                continue;
            data.caughtUp = data.catchUp(data, dt, time);
        }
    }
    send(action)
    {
        if(!this.isLocal)
            return;

        let data = {};
        for(const [key, value] of Object.entries(this.sendingData))
        {
            data[key] = value.getter();
        }
        action.send(data);
    }
    setPos(vector3)
    {
        this.pos.copy(vector3);
        if(!!this.mesh)
            this.mesh.position.copy(this.pos);
    }
    addPos(vector3)
    {
        this.pos.add(vector3);
        if(!!this.mesh)
            this.mesh.position.copy(this.pos);
    }
    getPos() { return this.pos.clone(); }
    setMesh(mesh)
    {
        if(!mesh)
            return;
        const prevMesh = this.mesh;
        this.mesh = mesh.clone();
        this.mesh.position.copy(this.pos);
        if(this.handler)
        {
            this.handler.scene.remove(prevMesh);
            this.handler.scene.add(this.mesh);
        }
    }
}

export class inputManager
{
    w = 0;
    h = 0;
    dpr = 1;
    held = [];
    buttonSubscribers = {};
    cursorMoveSubscribers = {};
    constructor(w, h, dpr)
    {
        this.w = w;
        this.h = h;
        this.dpr = dpr;

        //mouse input
        document.addEventListener("mousemove", (event) => this.cursorMoveEvent(event));
        document.addEventListener("mousedown", (event) => {
            const key = ["leftmouse", "middlemouse", "rightmouse"][event.button];
            this.buttonEvent({key: key}, false);
        });
        document.addEventListener("mouseup", (event) => {
            const key = ["leftmouse", "middlemouse", "rightmouse"][event.button];
            this.buttonEvent({key: key}, true);
        })

        //keyboard input
        window.addEventListener("keydown", (event) => this.buttonEvent(event, false));
        window.addEventListener("keyup", (event) => this.buttonEvent(event, true))

        //touch input
        const handleTouch = (event) =>
        {
            event.preventDefault();
            const touchEvent = event.touches[0];
            this.cursorMoveEvent(touchEvent);
        }
        document.addEventListener("touchmove", handleTouch, { passive: false });
        document.addEventListener("touchstart", handleTouch, { passive: false });

        //receive mouse information from parent page
        window.addEventListener("message", (event) => {
            if(event.data.type == "mouseEvent")
                this.cursorMoveEvent(event.data);
        });
    }
    buttonEvent(event, released)
    {
        const key = event.key.toLowerCase();
        const entry = this.buttonSubscribers[key] ?? [[],[]];
        for(const sub of entry[released ? 1 : 0])
        {
            sub.callback();
        }
        if(!released && !this.held.includes(key))
            this.held.push(key);
        else if(released)
            this.held.splice(this.held.indexOf(key), 1);
    }
    cursorMoveEvent(event)
    {
        const pos = new THREE.Vector2(event.clientX * dpr, event.clientY * dpr);
        const deltaPos = new THREE.Vector2(event.movementX, event.movementY);

        //convert to normalized device coordinates (NDC) (-1 to 1)
        const coord = new THREE.Vector2(
            (event.clientX / this.w) * 2 - 1,
            (event.clientY / this.h) * 2 - 1
        );
        const deltaCoord = new THREE.Vector2(deltaPos.x / this.w, deltaPos.y / this.h);

        for(const [key, sub] of Object.entries(this.cursorMoveSubscribers))
        {
            sub.callback({ pos: pos, deltaPos: deltaPos, coord: coord, deltaCoord: deltaCoord });
        }
    }
    subscribeToButton(gameObj, inputStr, released, callback)
    {
        const str = inputStr.toLowerCase();
        //if inputStr doesnt exist in subscribers then initialize as array with an empty array for pressed and released before pushing to the respective array
        const entry = this.buttonSubscribers[str] ??= [[],[]];
        entry[released ? 1 : 0].push({ gameObj: gameObj, callback: callback });
    }
    subscribeToCursorMove(gameObj, callback) { this.cursorMoveSubscribers[gameObj] = { callback: callback }; }
    unsubscribeFromCursorMove(gameObj) { delete this.cursorMoveSubscribers[gameObj]; }
    unsubscribeFromButton(inputStr, released, gameObj)
    {
        const str = inputStr.toLowerCase();
        const arr = this.buttonSubscribers[str][released ? 1 : 0];
        this.buttonSubscribers[str][released ? 1 : 0] = arr.filter(e => e.gameObj != gameObj);
    }
    unsubscribeFromAllButtons(gameObj)
    {
        for(const [key, value] of Object.entries(this.buttonSubscribers))
        {
            for(let i = 0; i < 1; i++)
            {
                value[i] = value[i].filter(e => e.gameObj != gameObj);
            }
        }
    }
    unsubscribeFromAllInput(gameObj)
    {
        this.unsubscribeFromAllButtons(gameObj);
        this.unsubscribeFromCursorMove(gameObj);
    }
    isHeld(inputStr){ return this.held.includes(inputStr.toLowerCase()); }
    updateScreenVars(w, h, dpr)
    {
        this.w = w;
        this.h = h;
        this.dpr = dpr;
    }
}

export class gameState 
{
    players = {};
    controlledPlayerId = -1;
    constructor(){}
    addPlayer(obj, id) { this.players[id] = obj; }
    removePlayer(id) { delete this.players[id]; }
    getPlayer(id) { return this.players[id]; }
    setControlledPlayer(id)
    {
        if(this.controlledPlayer != -1)
            this.players[id].setControlled(false);
        this.controlledPlayerId = id;
        this.players[id].setControlled(true);
    }
}

export class player extends gameObject
{
    cameraRoot = new THREE.Object3D();
    height = 0;
    speed = 3;
    id = 0;
    controlled = false;
    headMesh = null;
    constructor(args)
    {
        super(args.handler.meshes.player, Object.hasOwn(args, "isLocal") ? args.isLocal : true);
        
        this.height = this.mesh.geometry.parameters.height;
        this.mesh.add(this.cameraRoot);
        this.headMesh = args.handler.meshes.playerHead.clone();
        this.headMesh.rotateX(-Math.PI / 4);
        this.cameraRoot.add(this.headMesh);
        this.cameraRoot.position.set(0, -this.height, this.height * 1.5);

        this.id = args.id ?? 0;
        args.handler.gameState.addPlayer(this, this.id);

        this.setPos(args.startPos ?? new THREE.Vector3(0, 0, 10));

        this.addSendingData("position", () => trimVector3(this.getPos()),
        (data, dt, time) => {
            this.setPos(lerp(this.getPos(), data.target, dt * 4));
            return this.getPos().sub(data.target).length < 0.01;
        });

        this.addSendingData("yaw", () => this.mesh.rotation.z, 
        (data, dt, time) => {
            const quat = new THREE.Quaternion();
            quat.setFromEuler(new THREE.Euler(0, 0, data.target, "XYZ"));
            this.mesh.quaternion.slerp(quat, dt * 4);
            return this.mesh.quaternion == quat;
        });

        this.addSendingData("headRotation", () => trimVector3(this.cameraRoot.rotation),
        (data, dt, time) => {
            const quat = new THREE.Quaternion();
            quat.setFromEuler(new THREE.Euler(data.target.x, data.target.y, data.target.z, "XYZ"));
            this.cameraRoot.quaternion.slerp(quat, dt * 4);
            return this.cameraRoot.quaternion == quat;
        });
    }
    setControlled(controlled)
    {
        if(controlled)
        {
            this.cameraRoot.add(this.handler.camera);
            this.handler.camera.position.set(0, 0, 0);
            this.handler.camera.lookAt(this.getPos().add(new THREE.Vector3(0, 1, this.height)));
            this.cameraRoot.remove(this.headMesh);

            this.handler.inputManager.subscribeToCursorMove(this, (e) => {
                this.mesh.rotateZ(-e.deltaCoord.x * 2);
                this.cameraRoot.rotateX(-e.deltaCoord.y * 2);
            });
        }
        else
        {
            this.cameraRoot.add(this.headMesh);
            this.handler.inputManager.unsubscribeFromAllInput(this);
        }
    }
    tick(dt, time)
    {
        super.tick();

        if(this.isLocal)
        {
            //calculate movement direction
            const moveInput = new THREE.Vector2();
            if(this.handler.inputManager.isHeld('w')) moveInput.y += 1;
            if(this.handler.inputManager.isHeld('s')) moveInput.y -= 1;
            if(this.handler.inputManager.isHeld('d')) moveInput.x += 1;
            if(this.handler.inputManager.isHeld('a')) moveInput.x -= 1;
            if(moveInput.length() > 0)
            {
                const pos = this.getPos();
                const forwardVector = new THREE.Vector3(0, 1, 0); //we consider the positive y direction to be forward
                forwardVector.applyQuaternion(this.mesh.quaternion);
                const ang = Math.atan2(moveInput.y, moveInput.x) - Math.PI / 2;
                //rotate forwardVector by angle of moveInput to get movement direction
                const movement = new THREE.Vector3(
                    Math.cos(ang) * forwardVector.x - Math.sin(ang) * forwardVector.y,
                    Math.sin(ang) * forwardVector.x + Math.cos(ang) * forwardVector.y,
                    0
                )

                this.setPos(pos.add(movement.multiplyScalar(this.speed * dt)));
            }
        }

        //gravity
        let pos = this.getPos();
        this.setPos(new THREE.Vector3(pos.x, pos.y, Math.max(this.height, pos.z - 9.8 * dt)));
    }
}

export class ground extends gameObject
{
    constructor(args)
    {
        super(args.handler.meshes.ground);
        this.setPos(new THREE.Vector3());
    }
}