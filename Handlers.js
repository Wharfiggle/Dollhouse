import * as THREE from "three";
import { GLTFLoader } from "jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "jsm/utils/SkeletonUtils.js";
import { joinRoom } from "trystero";
import { player } from "./Dollhouse.js";
import { MAX_METERS, MAX_METERS_DELTA, KEY_PRESSED, KEY_RELEASED, SENDING_DATA_IDS, FLAG_BYTES, COMPRESSION } from "./GameObject.js";


export class handler
{
    preloadMeshes = [ "./assets/PegMan.glb" ];
    modelLoader = new GLTFLoader();
    meshes = {};
    gltfData = {};
    meshSubscribers = {};
    gameObjects = [];
    localGameObjects = [];
    nonLocalGameObjects = [];
    removeGameObjects = [];
    unshiftGameObjects = []; //used for adding gameObjects to the start of the list, useful for affecting draw order for ui
    tagGroups = {};
    materials = {};
    input = null;
    collision = null;
    multiplayer = null;
    constructor(scene, camera, ui, ghostUi, materials, input, multiplayer, collision)
    {
        this.scene = scene;
        this.ui = ui;
        this.ghostUi = ghostUi;
        this.materials = materials;
        this.camera = camera;
        this.input = input;
        this.multiplayer = multiplayer;
        this.collision = collision;

        this.multiplayer.init(this);

        this.meshes = {
            ground: new THREE.Mesh(
                new THREE.PlaneGeometry(20, 20),
                materials.ground
            )
        };

        for(const filePath of this.preloadMeshes)
        {
            this.loadMesh(filePath);
        }
    }
    loadMesh(filePath)
    {
        this.modelLoader.load(
            filePath,
            (gltf) => {
                this.gltfData[filePath] = gltf;
                const entries = this.meshSubscribers[filePath];
                for(const callback of entries)
                {
                    callback(SkeletonUtils.clone(gltf.scene), gltf.animations);
                }
                delete this.meshSubscribers[filePath];
            }
        );
    }
    requestMesh(filePath, callback)
    {
        const gltf = this.gltfData[filePath];
        if(gltf)
            callback(SkeletonUtils.clone(gltf.scene), gltf.animations);
        else
        {
            this.meshSubscribers[filePath] ??= [];
            const subs = this.meshSubscribers[filePath];
            if(subs.length == 0 && !this.preloadMeshes.includes(filePath))
                this.loadMesh(filePath);
            subs.push(callback);
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
        
        this.scene.add(gameObj.mesh);

        if(under)
            this.unshiftGameObjects.push(gameObj);
        else
            this.gameObjects.push(gameObj);
    }
    removeGameObject(gameObj)
    {
        this.removeGameObjects.push(gameObj);
        gameObj.onRemove();
    }
    removeMesh(mesh) { this.scene.remove(mesh); }
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


export class collision
{
    cellSize = 2.0;
    statics = [];
    nonStatics = [];
    staticCells = new Map();
    debugDraw = false;
    getCellKey(posInd) //takes x, y, and z of cell index
    {
        return (posInd.x + MAX_METERS) + ((posInd.y + MAX_METERS) * MAX_METERS * 2) + ((posInd.z + MAX_METERS) * Math.pow(MAX_METERS * 2, 2));
    }
    getCellPos(key) //gets x, y, and z of cell index from cell key. for debug purposes only
    {
        let z = Math.floor(key / Math.pow(MAX_METERS * 2, 2));
        key -= z * Math.pow(MAX_METERS * 2, 2);
        let y = Math.floor(key / (MAX_METERS * 2));
        key -= y * MAX_METERS * 2;
        let x = key - MAX_METERS;
        y = y - MAX_METERS;
        z = z - MAX_METERS;
        return new THREE.Vector3(x, y, z);
    }
    addCollider(gameObj)
    {
        const arr = gameObj.collider.static ? this.statics : this.nonStatics;
        arr.push(gameObj);

        if(gameObj.collider.static)
        {
            for(const cellKey of gameObj.collider.cells)
            {
                const entry = this.staticCells.get(cellKey);
                if(!entry)
                {
                    this.staticCells.set(cellKey, [gameObj]);
                    continue;
                }
                entry.push(gameObj);
            }
        }

        gameObj.setDebugDraw(this.debugDraw);
    }
    removeCollider(gameObj)
    {
        const arr = gameObj.collider.static ? this.statics : this.nonStatics;
        arr.splice(arr.indexOf(gameObj), 1);
        
        if(gameObj.collider.static)
        {
            for(const cellKey of gameObj.collider.cells)
            {
                const cell = this.staticCells.get(cellKey);
                cell.splice(cell.indexOf(gameObj), 1);
            }
        }

        gameObj.setDebugDraw(false);
    }
    setDebugDraw(debugDraw)
    {
        if(this.debugDraw == debugDraw)
            return;

        this.debugDraw = debugDraw;
        for(const cgo of this.statics)
        {
            cgo.setDebugDraw(debugDraw);
        }
        for(const cgo of this.nonStatics)
        {
            cgo.setDebugDraw(debugDraw);
        }
    }
}


export class input
{
    w = 0;
    h = 0;
    canvas = null;
    held = [];
    buttonSubscribers = {};
    touchSubscribers = [new Map(), new Map()];
    cursorMoveSubscribers = new Map();
    prevTouch = new Map();
    constructor(w, h, canvas)
    {
        this.w = w;
        this.h = h;
        this.canvas = canvas;

        //mouse input
        this.canvas.addEventListener("mousemove", (event) => this.cursorMoveEvent(event));
        this.canvas.addEventListener("mousedown", (event) => {
            const key = ["leftmouse", "middlemouse", "rightmouse"][event.button];
            this.buttonEvent({key: key}, KEY_PRESSED);
        });
        this,canvas.addEventListener("mouseup", (event) => {
            const key = ["leftmouse", "middlemouse", "rightmouse"][event.button];
            this.buttonEvent({key: key}, KEY_RELEASED);
        })

        //keyboard input
        window.addEventListener("keydown", (event) => this.buttonEvent(event, KEY_PRESSED));
        window.addEventListener("simkeydown", (event) => this.buttonEvent(event, KEY_PRESSED));
        window.addEventListener("keyup", (event) => this.buttonEvent(event, KEY_RELEASED));
        window.addEventListener("simkeyup", (event) => this.buttonEvent(event, KEY_RELEASED));

        //touch input
        this.canvas.addEventListener("touchstart", (event) => {
            event.preventDefault();
            for(const touch of event.touches)
            {
                const pos = new THREE.Vector2(touch.clientX, touch.clientY);
                this.prevTouch.set(touch.identifier, pos);
                this.cursorMoveEvent(touch, null, touch.identifier, pos);
                this.touchEvent(touch, false);
            }
        }, { passive: false });
        this.canvas.addEventListener("touchmove", (event) => {
            event.preventDefault();
            for(const touch of event.touches)
            {
                const pos = new THREE.Vector2(touch.clientX, touch.clientY);
                const prevPos = this.prevTouch.get(touch.identifier) ?? new THREE.Vector2();
                const deltaPos = pos.clone().sub(prevPos);
                this.prevTouch.set(touch.identifier, pos);
                this.cursorMoveEvent(touch, deltaPos, touch.identifier);
            }
        }, { passive: false });
        this.canvas.addEventListener("touchend", (event) => {
            event.preventDefault();
            for(const touch of event.changedTouches)
            {
                this.touchEvent(touch, true);
            }
        }, { passive: false });
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
    cursorMoveEvent(event, deltaPos = null, touchIdentifier = null)
    {
        //calculate commonly needed cursor information
        const pos = new THREE.Vector2(event.clientX, event.clientY);
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
            sub.callback({ pos: pos, deltaPos: deltaPos, coord: coord, deltaCoord: deltaCoord, touchIdentifier: touchIdentifier });
        }
    }
    touchEvent(event, released)
    {
        const pos = new THREE.Vector2(event.clientX, event.clientY);
        const coord = new THREE.Vector2(
            (event.clientX / this.w) * 2 - 1,
            (event.clientY / this.h) * 2 - 1
        );
        for(const [gameObj, sub] of this.touchSubscribers[released ? 1 : 0])
        {
            sub.callback({ pos: pos, coord: coord, touchIdentifier: event.identifier, released: released });
        }
    }
    subscribeToButton(gameObj, inputStr, released, callback)
    {
        const str = inputStr.toLowerCase();
        //if inputStr doesnt exist in subscribers then initialize as array with an empty array for pressed and released before pushing to the respective array
        this.buttonSubscribers[str] ??= [[],[]];
        this.buttonSubscribers[str][released ? 1 : 0].push({ gameObj: gameObj, callback: callback });
    }
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
    subscribeToCursorMove(gameObj, callback) { this.cursorMoveSubscribers.set(gameObj, { callback: callback }); }
    unsubscribeFromCursorMove(gameObj) { this.cursorMoveSubscribers.delete(gameObj); }
    subscribeToTouch(gameObj, released, callback) { this.touchSubscribers[released ? 1 : 0].set(gameObj, { callback: callback }); }
    unsubcribeFromTouch(gameObj, released) { this.touchSubscribers[released ? 1 : 0].delete(gameObj); }
    unsubscriberFromAllTouch(gameObj)
    {
        this.touchSubscribers[0].delete(gameObj);
        this.touchSubscribers[1].delete(gameObj);
    }
    unsubscribeFromAllInput(gameObj)
    {
        this.unsubscribeFromAllButtons(gameObj);
        this.unsubscribeFromCursorMove(gameObj);
        this.unsubscribeFromAllTouch(gameObj);
    }
    isHeld(inputStr){ return this.held.includes(inputStr.toLowerCase()); }
    updateScreenVars(w, h)
    {
        this.w = w;
        this.h = h;
    }
}


export class multiplayer
{
    sendInterval = 1 / 20; //period at which delta data is sent (more compressed)
    sendFullInterval = 1; //period at which full data is sent
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
            const flags = new Uint8Array(update.buffer, update.byteOffset, FLAG_BYTES);
            let offset = FLAG_BYTES;
            const full = flags[0] & 1;
            let data = {};
            const numFlags = Object.keys(SENDING_DATA_IDS).length + 1;
            for(let i = 1; i < numFlags; i++)
            {
                const byte = Math.floor(i / 8);
                const bitInByte = i % 8;
                if(flags[byte] & (1 << bitInByte))
                {
                    const id = i - 1;
                    const sendingData = player.sendingData[id];
                    const valLength = sendingData.getter().length;
                    const comp = COMPRESSION[sendingData.unit];
                    const isDelta = !full && comp.delta;
                    const valueBytes = isDelta ? comp.bytes / 2 : comp.bytes;
                    const getter = (comp.signed ? "getInt" : "getUint") + (8 * valueBytes);
                    data[id] = [];
                    for(let j = 0; j < valLength; j++)
                    {
                        let value = view[getter](offset);
                        offset += valueBytes;
                        if(comp.numValues > 1)
                        {
                            value = [value];
                            for(let k = 1; k < comp.numValues; k++)
                            {
                                value.push(view[getter](offset));
                                offset += valueBytes;
                            }
                        }
                        data[id].push(comp.decompress(value));
                    }
                }
            }

            //send received data to respective player object
            for(const [id, value] of Object.entries(data))
            {
                player.receiveCatchUpData(id, value, full);
            }
        };
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
    getControlledPlayer() { return this.players[this.controlledPlayerId]; }
    setControlledPlayer(id)
    {
        if(this.controlledPlayerId != id && this.controlledPlayerId != -1)
            this.players[this.controlledPlayerId].setControlled(false);
        this.controlledPlayerId = id;
        this.players[id].setControlled(true);
    }
}