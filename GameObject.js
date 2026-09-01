import * as THREE from "three";
import { joinRoom } from "trystero";
import { GLTFLoader } from "jsm/loaders/GLTFLoader.js";

const modelLoader = new GLTFLoader();

const uiScaleHeight = 1000;

let dpr = window.devicePixelRatio || 1;

//essentially an enum for sendingDatas
const sendingDataIds = {
    pos: 0,
    yaw: 1,
    headPitch: 2,
    red: 3
};

//number of bytes needed to store all flags, 1 for full and 1 for every sendingDataId
const flagBytes = Math.ceil((1 + Object.keys(sendingDataIds).length) / 8);

//compression information and methods stored by unit
//bytes must be a power of 2
const compression = {
    "": { //default
        compress: (v) => v,     //method to compress given value
        decompress: (v) => v,   //method to decompress given value
        bytes: 1,               //number of bytes needed to store
        signed: true,           //does it matter if this unit is negative?
        delta: false,           //can compressed deltas be calculated and sent most of the time instead of the full value? (should be false if bytes is 1)
        clamp: false,           //should a value be clamped instead of allowing overflow?
    },
    radians: { 
        compress: (v) => { return Math.round(((v + Math.PI) / (Math.PI * 2)) * 255); },
        decompress: (v) => { return (v / 255.0) * (Math.PI * 2) - Math.PI; },
        bytes: 1,
        signed: false,
        delta: false,
        clamp: false
    },
    meters: {
        compress: (v) => { return Math.round(v * 100); },
        decompress: (v) => { return v / 100; },
        bytes: 2,
        signed: true,
        delta: true,
        clamp: true
    }
}


function clampByBytes(value, bytes, signed)
{
    const num = Math.pow(2, bytes * 8);
    if(!signed)
        return Math.max(0, Math.min(num - 1, value));
    else
        return Math.max(-num / 2, Math.min(num / 2 - 1, value));
}

function subArrays(arr1, arr2)
{
    let result = [];
    for(let i = 0; i < arr1.length; i++)
    {
        result.push(arr1[i] - arr2[i]);
    }
    return result;
}
function addArrays(arr1, arr2)
{
    let result = [];
    for(let i = 0; i < arr1.length; i++)
    {
        result.push(arr1[i] + arr2[i]);
    }
    return result;
}


function lerp(vec1, vec2, t)
{
    const a = vec1.clone();
    const b = vec2.clone();
    return a.add( b.sub(a).multiplyScalar(t) );
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
    input = null;
    multiplayer = null;
    //todo, store colliders in here and only check for collisions with colliders that share a sector
    colliders = {
        gameObjects: [],
        cellSize: 2.0
    }
    constructor(scene, camera, ui, ghostUi, meshes, input, multiplayer)
    {
        this.scene = scene;
        this.ui = ui;
        this.ghostUi = ghostUi;
        this.meshes = meshes;
        this.camera = camera;
        this.input = input;
        this.multiplayer = multiplayer;

        this.multiplayer.init(this);

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
        if(gameObj.tags.includes(str))
            return;
        gameObj.tags.push(str);
        this.tagGroups[str] ??= [];
        this.tagGroups[str].push(gameObj);
    }
    removeTag(gameObj, str)
    {   
        gameObj.tags.splice(gameObj.tags.indexOf(str), 1);
        const tg = this.tagGroups[str];
        if(tg != null)
            tg.splice(tg.indexOf(gameObj), 1);
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
            go.catchUp(this.multiplayer.sendInterval, dt, time);
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

        //check each unique pairing of active collisionGameObjects for collisions and resolve them
        const numColliders = this.colliders.gameObjects.length;
        for(let i = 0; i < numColliders; i++)
        {
            const cgo = this.colliders.gameObjects[i];
            for(let j = i + 1; j < numColliders; j++)
            {
                cgo.checkForCollision(this.colliders.gameObjects[j]);
            }
        }
    }
    send(action, full, all)
    {
        for(const go of this.localGameObjects)
        {
            go.send(action, full, all);
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
    lastSentData = {};
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
    addSendingData(id, unit, getter, format, catchUp)
    {
        this.sendingData[id] = { getter: getter, unit: unit };
        this.catchUpData[id] = { catchUp: catchUp, format: format, caughtUp: true, target: null, start: null, timer: 0 };
    }
    receiveCatchUpData(id, target, full)
    {
        if(target == null)
            return console.error("Received null data! Discarding...", id, target);
        const cud = this.catchUpData[id];
        const sd = this.sendingData[id];
        const start = sd.getter();
        const targ = full || !compression[sd.unit].delta ? target : addArrays(start, target);
        this.catchUpData[id] = {
            catchUp: cud.catchUp,
            format: cud.format,
            caughtUp: false,
            target: cud.format(targ),
            start: cud.format(start),
            timer: 0
        };
    }
    catchUp(sendInterval, dt, time)
    {
        for(const [key, data] of Object.entries(this.catchUpData))
        {
            if(data.caughtUp)
                continue;
            data.timer += dt;
            const t = Math.min(1, data.timer / sendInterval);
            data.caughtUp = data.catchUp(data, t, sendInterval, dt, time);
        }
    }
    send(action, full, all)
    {
        if(!this.isLocal)
            return;

        if(all)
            full = true;

        //collect data that needs to be sent and calculate deltas
        let data = {};
        let anyData = false;
        for(const [key, sd] of Object.entries(this.sendingData))
        {
            const value = sd.getter();
            const sendDelta = !full && (compression[sd.unit] ?? {}).delta;
            const lsd = this.lastSentData[key];
            if(lsd == null) //haven't sent anything yet, send full value even if full is false
            {
                data[key] = value;
                this.lastSentData[key] = [value, value];
                full = true;
                anyData = true;
            }
            else
            {
                const lastFull = lsd[0];
                const lastSent = lsd[1];
                //only send if value has changed or if all is true
                if(all || !value.every((v, i) => v == lastSent[i]))
                {
                    let sentData = value;
                    if(sendDelta)
                        sentData = subArrays(value, lastFull);
                    data[key] = sentData;
                    this.lastSentData[key] = [value, sentData]; //[full value, actual sent data (can be delta or full)]
                    anyData = true;
                }
            }
        }

        if(anyData)
        {
            //make bit field for flags representing full and each sendingDataId present in the sent data
            const flags = new Uint8Array(flagBytes);
            flags[0] |= full;
            for(const [name, id] of Object.entries(sendingDataIds))
            {
                if(Object.hasOwn(data, id))
                    flags[Math.floor((id + 1) / 8)] |= 1 << ((id + 1) % 8);
            }

            //calculate total bytes needed and store relevant compression objects
            const dataEntries = Object.entries(data);
            const dataCompression = {};
            const dataNumBytes = {};
            let totalBytes = flags.byteLength;
            for(const [id, value] of dataEntries)
            {
                const comp = compression[this.sendingData[id].unit];
                dataCompression[id] = comp;
                const isDelta = !full && comp.delta;
                const numBytes = isDelta ? comp.bytes / 2 : comp.bytes;
                dataNumBytes[id] = numBytes;
                totalBytes += numBytes * value.length;
            }

            //create buffer, add flags, then add data
            const buffer = new ArrayBuffer(totalBytes);
            const view = new DataView(buffer);
            view["setUint" + (8 * flags.byteLength)](0, flags);
            let offset = flags.byteLength;
            for(const [id, value] of dataEntries)
            {
                const comp = dataCompression[id];
                const valueBytes = dataNumBytes[id];
                const setter = (comp.signed ? "setInt" : "setUint") + (8 * valueBytes);
                for(let i = 0; i < value.length; i++)
                {
                    //clamp so values that are too big to fit in their allocated bytes dont roll over
                    let compressedValue = comp.compress(value[i]);
                    if(comp.clamp)
                        compressedValue = clampByBytes(compressedValue, valueBytes, comp.signed);
                    view[setter](offset, compressedValue);
                    offset += valueBytes;
                }
            }

            action.send(buffer);
        }
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

export class collisionGameObject extends gameObject
{
    collider = {
        radius: 0,
        height: 0,
        pos: new THREE.Vector3(),
        static: false,
        active: false
    }
    constructor(mesh = null, isLocal = true)
    {
        super(mesh, isLocal);
    }
    setCollider(radius, height, pos, handler = null)
    {
        this.collider.radius = radius;
        this.collider.height = height;
        this.collider.pos = pos;
        handler ??= this.handler;
        if(!this.collider.active)
            this.setColliderActive(true, handler);
    }
    setColliderStatic(s) { this.collider.static = s; }
    setColliderActive(active, handler = null)
    {
        this.collider.active = active;
        handler ??= this.handler;
        if(active)
            handler.colliders.gameObjects.push(this);
        else
            handler.colliders.splice(handler.colliders.indexOf(this), 1);
    }
    checkForCollision(gameObj)
    {
        //no collision resolution possible if both colliders are static
        if(this.collider.static && gameObj.collider.static)
            return;

        //see if heights intersect
        const myPos = this.getPos().add(this.collider.pos);
        const myHalfHeight = this.collider.height / 2;
        const myBottom = myPos.z - myHalfHeight;
        const myTop = myPos.z + myHalfHeight;
        const yourPos = gameObj.getPos().add(gameObj.collider.pos);
        const yourHalfHeight = gameObj.collider.height / 2;
        const yourBottom = yourPos.z - yourHalfHeight;
        const yourTop = yourPos.z + yourHalfHeight;

        const verticalOverlap = myPos.z < yourPos.z ? myTop - yourBottom : yourTop - myBottom;
        if(verticalOverlap <= 0)
            return; //heights do not intersect

        //see if radii intersect
        const minDist = this.collider.radius + gameObj.collider.radius;
        const horizontalOverlap = minDist - new THREE.Vector2(myPos.x, myPos.y).sub(new THREE.Vector2(yourPos.x, yourPos.y)).length();
        if(horizontalOverlap > 0)
        {
            //resolve collision through either vertical vs horizontal overlap, whichever is smaller
            const overlap = Math.min(verticalOverlap, horizontalOverlap);
            if(verticalOverlap < horizontalOverlap)
            {
                myPos.set(0, 0, myPos.z);
                yourPos.set(0, 0, yourPos.z);
            }
            else
            {
                myPos.set(myPos.x, myPos.y, 0);
                yourPos.set(yourPos.x, yourPos.y, 0);
            }
            const diff = yourPos.sub(myPos);
            const dir = diff.clone().normalize();
            if(gameObj.collider.static)
            {
                const correction = dir.clone().multiplyScalar(-overlap);
                this.addPos(correction);
                this.onCollision(correction);
            }
            else if(this.collider.static)
            {
                const correction = dir.clone().multiplyScalar(overlap);
                gameObj.addPos(correction);
                gameObj.onCollision(correction);
            }
            else
            {
                let correction = dir.clone().multiplyScalar(-overlap / 2);
                this.addPos(correction);
                this.onCollision(correction);
                correction = dir.clone().multiplyScalar(overlap / 2);
                gameObj.addPos(correction);
                gameObj.onCollision(correction);
            }
        }
    }
    onCollision(correction){}
}

export class input
{
    w = 0;
    h = 0;
    dpr = 1;
    held = [];
    buttonSubscribers = {};
    cursorMoveSubscribers = new Map();
    prevTouch = new THREE.Vector2();
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
        document.addEventListener("touchstart", (event) => {
            event.preventDefault();
            const touchEvent = event.touches[0];
            this.prevTouch = new THREE.Vector2(touchEvent.clientX, touchEvent.clientY);
            this.cursorMoveEvent(touchEvent);
        }, { passive: false });
        document.addEventListener("touchmove", (event) => {
            event.preventDefault();
            const touchEvent = event.touches[0];
            const pos = new THREE.Vector2(touchEvent.clientX, touchEvent.clientY);
            const deltaPos = pos.clone().sub(this.prevTouch)
            this.prevTouch = pos.clone();
            this.cursorMoveEvent(touchEvent, deltaPos);
        }, { passive: false });

        //receive mouse information from parent page
        window.addEventListener("message", (event) => {
            if(event.data.type == "mouseEvent")
                this.cursorMoveEvent(event.data);
        });
    }
    buttonEvent(event, released)
    {
        const key = event.key.toLowerCase();
        const entry = this.buttonSubscribers[key];
        
        //update held
        if(!released && !this.held.includes(key))
            this.held.push(key);
        else if(released)
            this.held.splice(this.held.indexOf(key), 1);
        
        //call callbacks of subscribers
        if(!entry)
            return;
        for(const sub of entry[released ? 1 : 0])
        {
            sub.callback();
        }
    }
    cursorMoveEvent(event, deltaPos = null)
    {
        //calculate commonly needed cursor information
        const pos = new THREE.Vector2(event.clientX * dpr, event.clientY * dpr);
        if(deltaPos == null)
            deltaPos = new THREE.Vector2(event.movementX, event.movementY);

        //convert to normalized device coordinates (NDC) (-1 to 1)
        const coord = new THREE.Vector2(
            (event.clientX / this.w) * 2 - 1,
            (event.clientY / this.h) * 2 - 1
        );
        const deltaCoord = new THREE.Vector2(deltaPos.x / this.w, deltaPos.y / this.h);

        //call callbacks of subscribers
        for(const [gameObj, sub] of this.cursorMoveSubscribers)
        {
            sub.callback({ pos: pos, deltaPos: deltaPos, coord: coord, deltaCoord: deltaCoord });
        }
    }
    subscribeToButton(gameObj, inputStr, released, callback)
    {
        const str = inputStr.toLowerCase();
        //if inputStr doesnt exist in subscribers then initialize as array with an empty array for pressed and released before pushing to the respective array
        this.buttonSubscribers[str] ??= [[],[]];
        this.buttonSubscribers[str][released ? 1 : 0].push({ gameObj: gameObj, callback: callback });
    }
    subscribeToCursorMove(gameObj, callback) { this.cursorMoveSubscribers.set(gameObj, { callback: callback }); }
    unsubscribeFromCursorMove(gameObj) { this.cursorMoveSubscribers.delete(gameObj); }
    unsubscribeFromButton(inputStr, released, gameObj)
    {
        const str = inputStr.toLowerCase();
        const arr = this.buttonSubscribers[str][released ? 1 : 0];
        this.buttonSubscribers[str][released ? 1 : 0] = arr.filter(e => e.gameObj !== gameObj);
    }
    unsubscribeFromAllButtons(gameObj)
    {
        for(const [key, value] of Object.entries(this.buttonSubscribers))
        {
            for(let i = 0; i < 1; i++)
            {
                value[i] = value[i].filter(e => e.gameObj !== gameObj);
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

export class multiplayer
{
    sendInterval = 1 / 20; //period at which delta data is sent (more compressed)
    sendFullInterval = 1 / 2; //period at which full data is sent
    sendTimer = 0;
    sendFullTimer = 0;
    room;
    stateUpdate;
    handler;
    players = {};
    controlledPlayerId = -1;
    playerJoined = false;
    init(handler)
    {
        this.handler = handler;
        this.room = joinRoom({ appId: "dollhouse" }, "test-room");
        this.room.onPeerJoin = (peerId) => {
            console.log("Player joined room: " + peerId);
            const newPlayer = this.handler.newGameObject(player, { id: peerId, isLocal: false, startPos: new THREE.Vector3(0, 0, 10)});
            this.addPlayer(newPlayer, peerId);
            this.playerJoined = true;
        };
        this.room.onPeerLeave = (peerId) => {
            console.log("Player disconnected: " + peerId);
            this.handler.removeGameObject(this.getPlayer(peerId));
            this.removePlayer(peerId);
        };
        this.stateUpdate = this.room.makeAction("stateUpdate");
        this.stateUpdate.onMessage = (update, { peerId }) => { 
            const player = this.getPlayer(peerId);

            //decompress received data
            const view = new DataView(update.buffer, update.byteOffset, update.byteLength);
            const flags = view["getUint" + (8 * flagBytes)](0);
            let offset = flagBytes;
            const full = flags & 1;
            let data = {};
            for(let i = 1; i < 8 * flagBytes; i++)
            {
                if(flags & Math.pow(2, i))
                {
                    const id = i - 1;
                    const sendingData = player.sendingData[id];
                    const valLength = sendingData.getter().length;
                    const comp = compression[sendingData.unit];
                    const isDelta = !full && comp.delta;
                    const valueBytes = isDelta ? comp.bytes / 2 : comp.bytes;
                    const getter = (comp.signed ? "getInt" : "getUint") + (8 * valueBytes);
                    data[id] = [];
                    for(let j = 0; j < valLength; j++)
                    {
                        data[id].push(comp.decompress(view[getter](offset)));
                        offset += valueBytes;
                    }
                }
            }

            //send received data to respective player object
            for(const [id, value] of Object.entries(data))
            {
                player.receiveCatchUpData(id, value, full);
            }
        }
    }
    send(dt, time)
    {
        this.sendTimer += dt;
        this.sendFullTimer += dt;
        if(this.sendTimer >= this.sendInterval)
        {
            let full = false;
            if(this.sendFullTimer >= this.sendFullInterval)
            {
                full = true;
                this.sendFullTimer = 0;
            }
            this.handler.send(this.stateUpdate, full, this.playerJoined);
            this.playerJoined = false;
            this.sendTimer = 0;
        }
    }
    addPlayer(obj, id) { this.players[id] = obj; }
    removePlayer(id) { delete this.players[id]; }
    getPlayer(id) { return this.players[id]; }
    setControlledPlayer(id)
    {
        if(this.controlledPlayerId != id && this.controlledPlayerId != -1)
            this.players[this.controlledPlayerId].setControlled(false);
        this.controlledPlayerId = id;
        this.players[id].setControlled(true);
    }
}

export class player extends collisionGameObject
{
    cameraRoot = new THREE.Object3D();
    height = 0;
    speed = 3;
    id = 0;
    controlled = false;
    headMesh = null;
    playerMesh = null;
    red = false;
    constructor(args)
    {
        super(new THREE.Object3D(), Object.hasOwn(args, "isLocal") ? args.isLocal : true);

        this.playerMesh = args.handler.meshes.player.clone();
        this.playerMesh.rotateX(Math.PI / 2);
        this.mesh.add(this.playerMesh);
        this.height = this.playerMesh.geometry.parameters.height;
        this.mesh.add(this.cameraRoot);
        this.headMesh = args.handler.meshes.playerHead.clone();
        this.cameraRoot.add(this.headMesh);
        this.cameraRoot.position.set(0, 0, this.height * 1.5);

        this.setCollider(this.playerMesh.geometry.parameters.radiusTop, this.height, new THREE.Vector3(), args.handler);

        this.playerMesh.material = this.playerMesh.material.clone();
        this.headMesh.material = this.headMesh.material.clone();

        this.id = args.id ?? 0;
        args.handler.multiplayer.addPlayer(this, this.id);

        this.setPos(args.startPos ?? new THREE.Vector3(0, 0, 10));

        this.addSendingData(sendingDataIds.pos, "meters",
            () => this.getPos().toArray(), 
            (toFormat) => new THREE.Vector3().fromArray(toFormat),
            (data, t) => {
                this.setPos(lerp(data.start, data.target, t));
                return t >= 1;
            });

        this.addSendingData(sendingDataIds.yaw, "radians",
            () => [this.mesh.rotation.z],
            (toFormat) => new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, toFormat[0])),
            (data, t) => {
                this.mesh.quaternion.slerpQuaternions(data.start, data.target, t);
                return t >= 1;
            });

        this.addSendingData(sendingDataIds.headPitch, "radians",
            () => [this.cameraRoot.rotation.x],
            (toFormat) => new THREE.Quaternion().setFromEuler(new THREE.Euler(toFormat[0], 0, 0)),
            (data, t) => {
                this.cameraRoot.quaternion.slerpQuaternions(data.start, data.target, t);
                return t >= 1;
            });

        this.addSendingData(sendingDataIds.red, "",
            () => [this.red],
            (toFormat) => toFormat[0],
            (data) => {
                this.setRed(data.target);
                return true;
            });
    }
    setRed(red)
    {
        if(red == this.red)
            return;
        this.red = red;
        const color = red ? "red" : "purple";
        this.playerMesh.material.color.set(color);
        this.headMesh.material.color.set(color);
    }
    setControlled(controlled)
    {
        if(controlled)
        {
            this.cameraRoot.add(this.handler.camera);
            this.handler.camera.position.set(0, 0, 0);
            this.handler.camera.rotation.set(Math.PI / 2, 0, 0);
            this.cameraRoot.remove(this.headMesh);

            this.handler.input.subscribeToCursorMove(this, (e) => {
                this.mesh.rotateZ(-e.deltaCoord.x * 2);
                this.cameraRoot.rotateX(-e.deltaCoord.y * 2);
                this.cameraRoot.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.cameraRoot.rotation.x));
            });
            this.handler.input.subscribeToButton(this, "r", false, () => this.setRed(true));
            this.handler.input.subscribeToButton(this, "r", true, () => this.setRed(false));
            this.handler.input.subscribeToButton(this, " ", false, () => {
                const pos = this.getPos();
                this.setPos(new THREE.Vector3(pos.x, pos.y, pos.z + 5));
            });
        }
        else
        {
            this.cameraRoot.add(this.headMesh);
            this.handler.input.unsubscribeFromAllInput(this);
        }
    }
    tick(dt, time)
    {
        super.tick();

        if(this.isLocal)
        {
            //calculate movement direction
            const moveInput = new THREE.Vector2();
            if(this.handler.input.isHeld('w')) moveInput.y += 1;
            if(this.handler.input.isHeld('s')) moveInput.y -= 1;
            if(this.handler.input.isHeld('d')) moveInput.x += 1;
            if(this.handler.input.isHeld('a')) moveInput.x -= 1;
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