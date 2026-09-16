import * as THREE from "three";
import { joinRoom } from "trystero";
import { GLTFLoader } from "jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "jsm/utils/SkeletonUtils.js";

const KEY_RELEASED = true;
const KEY_PRESSED = false;

const UI_SCALE_HEIGHT = 1000;

const MAX_METERS = 327;

let dpr = window.devicePixelRatio || 1;

//essentially an enum for sendingDatas
const sendingDataIds = {
    xy: 0,
    z: 1,
    yaw: 2,
    headPitch: 3,
    red: 4,
    pose: 5,
    placedDollPos: 6,
    placedDollYaw: 7,
    placedDollPose: 8
};
const poses = {
    Stand: { index: 0, collider: { radius: 0.3, height: 2, pos: new THREE.Vector3() } },
    TPose: { index: 1, collider: {}},
    Droop: { index: 2, collider: { radius: 0.5, height: 1.3, pos: new THREE.Vector3(0, 0.25, 0) }}
}

//number of bytes needed to store all flags, 1 bit for full and 1 bit for every sendingDataId
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
    },
    metersNoDelta: {
        compress: (v) => { return Math.round(v * 100); },
        decompress: (v) => { return v / 100; },
        bytes: 2,
        signed: true,
        delta: false,
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


function lerpVec(vec1, vec2, t)
{
    const a = vec1.clone();
    const b = vec2.clone();
    return a.add( b.sub(a).multiplyScalar(t) );
}
function lerp(a, b, t) { return a + (b - a) * t; }

function clampVec3(vec, min, max) { return new THREE.Vector3(Math.max(min, Math.min(max, vec.x)), Math.max(min, Math.min(max, vec.y)), Math.max(min, Math.min(max, vec.z))); }

function worldToScreen(vector3, camera, screenWidth, screenHeight)
{
    const screenPos = vector3.clone().project(camera);
    return new THREE.Vector2((1.0 + screenPos.x) * screenWidth / 2, (1.0 - screenPos.y) * screenHeight / 2);
}

export class handler
{
    preloadMeshes = [ "./StumpyMannequin.glb" ];
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
    camera = null;
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
            playerHead: new THREE.Mesh(
                new THREE.ConeGeometry(0.25, 0.5, 4),
                materials.player
            ),
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
    removeGameObject(gameObj) { this.removeGameObjects.push(gameObj); }
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
    constructor(h = null, mesh = null, isLocal = true)
    {
        super();
        this.handler = h;
        console.assert(h == null || h instanceof handler, "Handler was not passed properly to a GameObject. If handler is intended to be null, then pass null.");
        this.mesh = mesh ? mesh.clone() : new THREE.Object3D();
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
            if(value == null || value.length == 0 || value[0] == null)
            {
                this.lastSentData[key] = [[],[]];
                continue;
            }
            const comp = compression[sd.unit];
            const sendDelta = !full && comp.delta;
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
            //view["setUint" + (8 * flags.byteLength)](0, flags);
            new Uint8Array(buffer).set(flags, 0);
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
        this.mesh.position.copy(this.pos);
    }
    addPos(vector3)
    {
        this.pos.add(vector3);
        this.mesh.position.copy(this.pos);
    }
    getPos() { return this.pos.clone(); }
    setMesh(mesh)
    {
        if(!mesh)
            return;
        const prevMesh = this.mesh;
        this.mesh = mesh;
        this.mesh.position.copy(this.pos);
        this.mesh.rotation.copy(prevMesh.rotation);
        if(this.handler)
        {
            this.handler.scene.remove(prevMesh);
            this.handler.scene.add(this.mesh);
        }
    }
}

export class collision
{
    cellSize = 2.0;
    statics = [];
    nonStatics = [];
    staticCells = new Map();
    debugDraw = false;
    getCellKey(pos)
    {
        return Math.floor(((pos.x + MAX_METERS) + (pos.y + MAX_METERS) * MAX_METERS * 2 + (pos.z + MAX_METERS) * Math.pow(MAX_METERS * 2, 2)) / this.cellSize);
    }
    addCollider(gameObj)
    {
        if(gameObj.collider.static)
            this.statics.push(gameObj);
        else
            this.nonStatics.push(gameObj);

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
        gameObj.collider.cells = [];
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

//todo move functions to collider?
export class collisionGameObject extends gameObject
{
    collider = {
        radius: 0,
        height: 0,
        pos: new THREE.Vector3(),
        static: false,
        active: false,
        worldPos : new THREE.Vector3(),
        cells: [],
        debugDrawMesh: null
    }
    prevPos = new THREE.Vector3();
    prevYaw =  null;
    groundLevel = 0;
    constructor(h = null, mesh = null, isLocal = true)
    {
        super(h, mesh, isLocal);
    }
    setCollider(radius, height, bottomPos, isStatic, setActive = true)
    {
        this.collider.radius = radius;
        this.collider.height = height;
        this.collider.pos.set(bottomPos.x, bottomPos.y, bottomPos.z + height / 2);
        this.setColliderStatic(isStatic);
        if(setActive && !this.collider.active)
            this.setColliderActive(true);
        else
            this.calculateColliderWorldPos(true);

        if(this.collider.debugDrawMesh)
            this.setDebugDraw(true);
    }
    setColliderFromPose(pose, isStatic, setActive)
    {
        const col = pose.collider;
        const radius = Object.hasOwn(col, "radius") ? col.radius : poses.Stand.collider.radius;
        const height = Object.hasOwn(col, "height") ? col.height : poses.Stand.collider.height;
        const pos = Object.hasOwn(col, "pos") ? col.pos : poses.Stand.collider.pos;
        this.setCollider(radius, height, pos, isStatic, setActive);
    }
    setColliderStatic(isStatic)
    {
        if(this.collider.static == isStatic)
            return;

        if(this.collider.active)
        {
            this.handler.collision.removeCollider(this);
            this.collider.static = isStatic;
            this.handler.collision.addCollider(this);
        }
        else
            this.collider.static = isStatic;
    }
    setColliderActive(active)
    {
        if(active == this.collider.active)
            return;

        this.collider.active = active;
        if(active)
        {
            this.handler.collision.addCollider(this);
            this.calculateColliderWorldPos(true);
        }
        else
            this.handler.collision.removeCollider(this);
    }
    calculateColliderWorldPos(reset = false)
    {
        const pos = this.getPos();
        const colPos = this.collider.pos;
        const yaw = this.mesh.rotation.z;
        const result = new THREE.Vector3(
            pos.x + colPos.x * Math.cos(yaw) - colPos.y * Math.sin(yaw),
            pos.y + colPos.x * Math.sin(yaw) + colPos.y * Math.cos(yaw),
            pos.z + colPos.z);
        
        this.collider.worldPos.copy(result);

        const cellSize = this.handler.collision.cellSize;
        const newCells = [];
        const minCellX = Math.floor((result.x - this.collider.radius) / cellSize);
        const maxCellX = Math.floor((result.x + this.collider.radius) / cellSize);
        const minCellY = Math.floor((result.y - this.collider.radius) / cellSize);
        const maxCellY = Math.floor((result.y + this.collider.radius) / cellSize);
        const minCellZ = Math.floor((result.z - this.collider.height / 2) / cellSize);
        const maxCellZ = Math.floor((result.z + this.collider.height / 2) / cellSize);
        for(let z = minCellZ; z <= maxCellZ; z++)
        {
            for(let y = minCellY; y <= maxCellY; y++)
            {
                for(let x = minCellX; x <= maxCellX; x++)
                {
                    newCells.push(this.handler.collision.getCellKey({ x: x * cellSize, y: y * cellSize, z: z * cellSize }));
                }
            }
        }

        if(reset)
            this.collider.cells = [];
        if(this.collider.static && this.collider.active)
        {
            for(const oldCell of this.collider.cells)
            {
                if(newCells.includes(oldCell))
                    continue;
                const entry = this.handler.collision.staticCells.get(oldCell);
                entry.splice(entry.indexOf(this), 1);
            }
            for(const newCell of newCells)
            {
                if(!reset && this.collider.cells.includes(newCell))
                    continue;
                let entry = this.handler.collision.staticCells.get(newCell);
                if(!entry)
                {
                    this.handler.collision.staticCells.set(newCell, [this]);
                    continue;
                }
                entry.push(this);
            }
        }
        this.collider.cells = newCells;
    }
    setDebugDraw(debugDraw)
    {
        if(!debugDraw)
        {
            this.mesh.remove(this.collider.debugDrawMesh);
            this.collider.debugDrawMesh = null;
        }
        else
        {
            if(this.collider.debugDrawMesh)
                this.mesh.remove(this.collider.debugDrawMesh);
            this.collider.debugDrawMesh = new THREE.Mesh(
                new THREE.CylinderGeometry(this.collider.radius, this.collider.radius, this.collider.height, 32), 
                new THREE.MeshStandardMaterial({color:"red", transparent:true, opacity:0.5}));
            this.mesh.add(this.collider.debugDrawMesh);
            if(Math.abs(this.mesh.rotation.x) == 0)
                this.collider.debugDrawMesh.rotateX(Math.PI / 2);
            this.collider.debugDrawMesh.position.copy(this.collider.pos);
        }
    }
    tick(dt, time)
    {
        super.tick(dt, time);

        if(!this.collider.active || this.collider.static)
            return;

        //see if we should check for collisions
        const rotationalSymmetry = this.collider.pos.x == 0 && this.collider.pos.y == 0;
        let checkFromYaw = false;
        if(rotationalSymmetry)
            this.prevYaw = null;
        else
            checkFromYaw = this.mesh.rotation.z != this.prevYaw;
        if(checkFromYaw || this.getPos().sub(this.prevPos).length() > 0)
        {
            //check for collisions from static colliders that share a cell with us
            const collisions = this.checkForCollisionsInCells();
            for(const c of collisions)
            {
                this.resolveCollision(c);
            }
            this.prevPos.copy(this.getPos());
            this.prevYaw = this.mesh.rotation.z;
        }
    }
    checkForCollisionsInCells()
    {
        this.calculateColliderWorldPos();
        const collisions = [];
        const checked = [];
        for(const cellKey of this.collider.cells)
        {
            const cell = this.handler.collision.staticCells.get(cellKey);
            if(!cell)
                continue;
            for(const s of cell)
            {
                if(checked.includes(s))
                    continue;

                const collision = this.checkForCollision(s);
                if(collision)
                    collisions.push(collision);
                
                checked.push(s);
            }
        }

        return collisions;
    }
    checkForCollision(gameObj)
    {
        //see if heights intersect
        const myPos = this.collider.worldPos;
        const myHalfHeight = this.collider.height / 2;
        const myBottom = myPos.z - myHalfHeight;
        const myTop = myPos.z + myHalfHeight;
        const yourPos = gameObj.collider.worldPos;
        const yourHalfHeight = gameObj.collider.height / 2;
        const yourBottom = yourPos.z - yourHalfHeight;
        const yourTop = yourPos.z + yourHalfHeight;

        const verticalOverlap = myPos.z < yourPos.z ? myTop - yourBottom : yourTop - myBottom;
        if(verticalOverlap <= 0)
            return false; //heights do not intersect

        //see if radii intersect
        const minDist = this.collider.radius + gameObj.collider.radius;
        const horizontalOverlap = minDist - new THREE.Vector2(myPos.x, myPos.y).sub(new THREE.Vector2(yourPos.x, yourPos.y)).length();
        if(horizontalOverlap > 0)
            return { horizontalOverlap: horizontalOverlap, verticalOverlap: verticalOverlap, myPos: myPos, yourPos: yourPos, myBottom: myBottom };
        else
            return false;
    }
    resolveCollision(args)
    {
        if(!args)
            return;

        //resolve collision through either vertical or horizontal overlap
        const useVertical = args.useHorizontal ? false : args.verticalOverlap < args.horizontalOverlap;
        const diff = useVertical ? new THREE.Vector3(0, 0, args.myPos.z - args.yourPos.z) : new THREE.Vector3(args.myPos.x - args.yourPos.x, args.myPos.y - args.yourPos.y, 0);
        const dir = diff.clone().normalize();

        //assume gameObj is static and we are not
        const correction = dir.clone().multiplyScalar(useVertical ? args.verticalOverlap : args.horizontalOverlap);
        
        //if correction would ever put us below ground level, dont do it and instead use horizontal displacement
        if(useVertical && correction.z + args.myBottom < this.groundLevel)
            return this.resolveCollision({ ...args, useHorizontal: true });
        
        this.addPos(correction);
        this.onCollision(correction);
    }
    onCollision(correction){}
}

export class basicCollider extends collisionGameObject
{
    constructor(args)
    {
        super(args.handler, new THREE.Mesh(new THREE.CylinderGeometry(args.radius, args.radius, args.height, 32), new THREE.MeshStandardMaterial({color:"black"})));
        let pos = args.pos;
        if(pos == null && args.bottomPos)
            pos = new THREE.Vector3(args.bottomPos.x, args.bottomPos.y, args.bottomPos.z + args.height / 2);
        if(pos != null)
            this.setPos(pos);
        this.setCollider(args.radius, args.height, new THREE.Vector3(0, 0, -args.height / 2), true);
        this.mesh.rotateX(Math.PI / 2);
    }
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
            this.buttonEvent({key: key}, KEY_PRESSED);
        });
        document.addEventListener("mouseup", (event) => {
            const key = ["leftmouse", "middlemouse", "rightmouse"][event.button];
            this.buttonEvent({key: key}, KEY_RELEASED);
        })

        //keyboard input
        window.addEventListener("keydown", (event) => this.buttonEvent(event, KEY_PRESSED));
        window.addEventListener("keyup", (event) => this.buttonEvent(event, KEY_RELEASED))

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
    sendFullInterval = 1; //period at which full data is sent
    sendTimer = 0;
    sendFullTimer = 0;
    room;
    stateUpdate;
    handler;
    players = {};
    controlledPlayerId = -1;
    playerJoined = false;
    placedDoll;
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
            const flags = new Uint8Array(update.buffer, 0, flagBytes);
            let offset = flagBytes;
            const full = flags[0] & 1;
            let data = {};
            const numFlags = Object.keys(sendingDataIds).length + 1;
            for(let i = 1; i < numFlags; i++)
            {
                const byte = Math.floor(i / 8);
                const bitInByte = i % 8;
                if(flags[byte] & (1 << bitInByte))
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
    getControlledPlayer() { return this.players[this.controlledPlayerId]; }
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
    speed = 3;
    climbSpeed = 1;
    climbCollider = null;
    climbing = false;
    animationMixer = null;
    poseActions = {};
    currentPose = poses.Stand;
    cameraRoot = new THREE.Object3D();
    id = 0;
    controlled = false;
    headMesh = null;
    playerMesh = null;
    red = false;
    gravity = 0;
    placedDoll = null;
    insidePlacedDoll = false;
    constructor(args)
    {
        super(args.handler, new THREE.Object3D(), Object.hasOwn(args, "isLocal") ? args.isLocal : true);

        this.mesh.add(this.cameraRoot);
        this.headMesh = this.handler.meshes.playerHead.clone();
        this.headMesh.material = this.headMesh.material.clone();
        this.cameraRoot.add(this.headMesh);
        this.cameraRoot.position.set(0, -2, 3);

        this.handler.requestMesh("./StumpyMannequin.glb", (scene, animations) => {
            this.playerMesh = scene;
            this.playerMesh.traverse((obj) => {
                if(obj.isMesh)
                    obj.material = this.handler.materials.player.clone();
            });
            this.mesh.add(this.playerMesh);
            this.playerMesh.rotateZ(Math.PI);

            this.animationMixer = new THREE.AnimationMixer(this.playerMesh);
            for(const key of Object.keys(poses))
            {
                const clip = THREE.AnimationClip.findByName(animations, key);
                this.poseActions[key] = this.animationMixer.clipAction(clip);
            }
            this.setPose("Stand");
        });

        this.id = args.id ?? 0;
        this.handler.multiplayer.addPlayer(this, this.id);

        this.setPos(args.startPos ?? new THREE.Vector3(0, 0, 10));

        this.addSendingData(sendingDataIds.xy, "meters",
            () => [this.pos.x, this.pos.y], 
            (toFormat) => new THREE.Vector2().fromArray(toFormat),
            (data, t) => {
                const xy = lerpVec(data.start, data.target, t);
                this.setPos(new THREE.Vector3(xy.x, xy.y, this.pos.z));
                return t >= 1;
            });
        this.addSendingData(sendingDataIds.z, "metersNoDelta",
            () => [this.getPos().z], 
            (toFormat) => toFormat[0],
            (data, t) => {
                this.setPos(new THREE.Vector3(this.pos.x, this.pos.y, lerp(data.start, data.target, t)));
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

        this.addSendingData(sendingDataIds.pose, "",
            () => [this.currentPose.index],
            (toFormat) => toFormat[0],
            (data) => {
                this.setPose(Object.keys(poses)[data.target]);
                return true;
            }
        )

        this.addSendingData(sendingDataIds.placedDollPos, "metersNoDelta",
            () => { return this.placedDoll == null ? Array(3) : this.placedDoll.getPos().toArray(); },
            (toFormat) => { return toFormat[0] == null ? null : new THREE.Vector3(toFormat[0], toFormat[1], toFormat[2]); },
            (data) => {
                this.placedDoll = this.handler.newGameObject(placedDoll, { pos: data.target, isLocal: false });
                return true;
            });
        this.addSendingData(sendingDataIds.placedDollYaw, "radians",
            () => { return this.placedDoll == null ? [null] : [this.placedDoll.mesh.rotation.z]; },
            (toFormat) => toFormat[0],
            (data) => {
                this.placedDoll.mesh.rotation.set(0, 0, data.target);
                return true;
            });
        this.addSendingData(sendingDataIds.placedDollPose, "",
            () => { return this.placedDoll == null ? [null] : [this.placedDoll.pose.index]; },
            (toFormat) => toFormat[0],
            (data) => {
                this.placedDoll.setPose(Object.keys(poses)[data.target]);
                return true;
            });
    }
    setPose(poseStr)
    {
        this.animationMixer.stopAllAction();
        this.currentPose = { ...poses[poseStr], name: poseStr };
        this.poseActions[poseStr].play();
        this.setColliderFromPose(this.currentPose, false);
        this.animationMixer.update(0);
    }
    send(action, full, all)
    {
        super.send(action, full, all);
        this.placedDoll = null;
    }
    catchUp(sendInterval, dt, time)
    {
        super.catchUp(sendInterval, dt, time);
        this.placedDoll = null;
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

            this.setCollider(0.3, 2, new THREE.Vector3(), false);
            this.climbCollider = new collisionGameObject(this.handler);

            this.handler.input.subscribeToCursorMove(this, (e) => {
                this.mesh.rotateZ(-e.deltaCoord.x * 2);
                this.cameraRoot.rotateX(-e.deltaCoord.y * 2);
                this.cameraRoot.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.cameraRoot.rotation.x));
            });
            this.handler.input.subscribeToButton(this, "r", KEY_PRESSED, () => this.setRed(!this.red));
            this.handler.input.subscribeToButton(this, "e", KEY_PRESSED, () => {
                if(this.insidePlacedDoll)
                    return;
                this.placedDoll = this.handler.newGameObject(placedDoll, {
                    pos: this.getPos(), 
                    yaw: this.mesh.rotation.z, 
                    pose: this.currentPose.name, isLocal: true 
                });
                this.insidePlacedDoll = true;
            });
            this.handler.input.subscribeToButton(this, " ", KEY_PRESSED, () => { this.climbing = true; })
            this.handler.input.subscribeToButton(this, " ", KEY_RELEASED, () => { this.climbing = false; })
            this.handler.input.subscribeToButton(this, "1", KEY_PRESSED, () => { this.setPose("Stand"); });
            this.handler.input.subscribeToButton(this, "2", KEY_PRESSED, () => { this.setPose("Droop"); });
            this.handler.input.subscribeToButton(this, "3", KEY_PRESSED, () => { this.setPose("TPose"); });
            this.handler.input.subscribeToButton(this, "`", KEY_PRESSED, () => { this.handler.collision.setDebugDraw(!this.handler.collision.debugDraw); })
        }
        else
        {
            this.cameraRoot.add(this.headMesh);
            this.handler.input.unsubscribeFromAllInput(this);
        }
    }
    tick(dt, time)
    {
        if(!this.isLocal)
            return;

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

            this.addPos(movement.multiplyScalar(this.speed * dt));
        }

        if(this.climbing)
        {
            const pos = this.getPos();
            this.climbCollider.setPos(pos);
            this.climbCollider.mesh.rotation.z = this.mesh.rotation.z;
            const bottomPos = new THREE.Vector3(this.collider.pos.x, this.collider.pos.y, this.collider.pos.z - this.collider.height / 2);
            this.climbCollider.setCollider(this.collider.radius + 0.2, this.collider.height, bottomPos, false, false);
            if(this.insidePlacedDoll || this.climbCollider.checkForCollisionsInCells().length > 0)
            {
                this.gravity = 0;
                this.setPos(new THREE.Vector3(pos.x, pos.y, pos.z + this.climbSpeed * dt));
            }
        }

        //gravity
        const groundedZ = this.groundLevel;
        if(this.pos.z > groundedZ)
        {
            if(this.gravity > 0)
            {
                const newZ = Math.max(groundedZ, this.pos.z - this.gravity);
                this.setPos(new THREE.Vector3(this.pos.x, this.pos.y, newZ));
            }

            this.gravity += dt;

            if(this.pos.z <= groundedZ)
                this.gravity = 0;
        }

        this.setPos(clampVec3(this.getPos(), -MAX_METERS, MAX_METERS));

        super.tick();
    }
    onCollision(correction)
    {
        if(correction.z > 0)
            this.gravity = 0;
    }
}

export class placedDoll extends collisionGameObject
{
    activePlayer;
    solid = false;
    dollMesh = null;
    pose = {};
    constructor(args)
    {
        super(args.handler, new THREE.Object3D(), args.isLocal);
        this.activePlayer = this.handler.multiplayer.getControlledPlayer();
        this.setPos(args.pos);
        if(args.yaw)
            this.mesh.rotation.z = args.yaw;
        if(args.pose)
            this.setPose(args.pose);
    }
    setPose(poseStr)
    {
        this.handler.requestMesh("./StumpyMannequin.glb", (scene, animations) => {
            this.dollMesh = scene;
            this.dollMesh.traverse((obj) => {
                if(obj.isMesh)
                    obj.material = this.handler.materials.placedDoll;
            });
            this.mesh.add(this.dollMesh);
            this.dollMesh.rotateZ(Math.PI);
            const mixer = new THREE.AnimationMixer(this.dollMesh);
            const clip = THREE.AnimationClip.findByName(animations, poseStr);
            mixer.clipAction(clip).play();
            mixer.update(0);
            this.pose = poses[poseStr];
            this.setColliderFromPose(this.pose, true, false);
        });
    }
    tick(dt, time)
    {
        if(!this.solid && !this.checkForCollision(this.activePlayer))
        {
            this.activePlayer.insidePlacedDoll = false;
            this.solid = true;
            this.setColliderActive(true);
            this.mesh.traverse((obj) => {
                if(obj.isMesh)
                    obj.material = this.handler.materials.player;
            });
        }
    }
}

export class ground extends gameObject
{
    constructor(args)
    {
        super(args.handler, args.handler.meshes.ground);
        this.setPos(new THREE.Vector3());
    }
}