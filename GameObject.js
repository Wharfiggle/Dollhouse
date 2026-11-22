import * as THREE from "three";


export const KEY_RELEASED = true;
export const KEY_PRESSED = false;

export const MAX_METERS = 327;
export const MAX_METERS_DELTA = 1.28;

//todo make all constants captial with underscores

//compression information and methods stored by unit
//bytes must be a power of 2
export const COMPRESSION = {
    "": { //default
        compress: (v) => v,     //method to compress given value (can return a single value or an array of values)
        decompress: (v) => v,   //method to decompress given value
        numValues: 1,           //number of values (number of values returned in compress. If not an array, should just be 1)
        bytes: 1,               //number of bytes needed to store per value
        signed: true,           //does it matter if this unit is negative?
        delta: false,           //can compressed deltas be calculated and sent most of the time instead of the full value? (should be false if bytes is 1)
        clamp: false,           //should a value be clamped instead of allowing overflow?
    },
    radians: { 
        compress: (v) => { return Math.round(((v + Math.PI) / (Math.PI * 2)) * 255); },
        decompress: (v) => { return (v / 255.0) * (Math.PI * 2) - Math.PI; },
        numValues: 1,
        bytes: 1,
        signed: false,
        delta: false,
        clamp: false
    },
    meters: {
        compress: (v) => { return Math.round(v * 100); },
        decompress: (v) => { return v / 100; },
        numValues: 1,
        bytes: 2,
        signed: true,
        delta: true,
        clamp: true
    },
    metersNoDelta: {
        compress: (v) => { return Math.round(v * 100); },
        decompress: (v) => { return v / 100; },
        numValues: 1,
        bytes: 2,
        signed: true,
        delta: false,
        clamp: true
    },
    color: {
        compress: (v) => [v.r * 255, v.g * 255, v.b * 255],
        decompress: (v) => new THREE.Color(`rgb(${v[0]}, ${v[1]}, ${v[2]})`),
        numValues: 3,
        bytes: 1,
        signed: false,
        delta: false,
        clamp: false
    }
}

//enum for sendingDatas
export const SENDING_DATA_IDS = {
    xy: 0,
    z: 1,
    targetYaw: 2,
    poseBody: 3,
    poseHead: 4,
    poseLeftArm: 5,
    poseRightArm: 6,
    poseLeftLeg: 7,
    poseRightLeg: 8,
    color: 9,
    placedDollPos: 10,
    placedDollYaw: 11,
    placedDollColor: 12,
    placedDollPose: 13
};

//number of bytes needed to store all flags, 1 bit for full and 1 bit for every sendingDataId
export const FLAG_BYTES = Math.ceil((1 + Object.keys(SENDING_DATA_IDS).length) / 8);


export function clampByBytes(value, bytes, signed)
{
    const num = Math.pow(2, bytes * 8);
    if(!signed)
        return Math.max(0, Math.min(num - 1, value));
    else
        return Math.max(-num / 2, Math.min(num / 2 - 1, value));
}

export function subArrays(arr1, arr2)
{
    let result = [];
    for(let i = 0; i < arr1.length; i++)
    {
        result.push(arr1[i] - arr2[i]);
    }
    return result;
}
export function addArrays(arr1, arr2)
{
    let result = [];
    for(let i = 0; i < arr1.length; i++)
    {
        result.push(arr1[i] + arr2[i]);
    }
    return result;
}

export function lerpVec(vec1, vec2, t)
{
    const a = vec1.clone();
    const b = vec2.clone();
    return a.add( b.sub(a).multiplyScalar(t) );
}
export function lerp(a, b, t) { return a + (b - a) * t; }

export function clampVec2(vec, min, max) { return new THREE.Vector2(Math.max(min, Math.min(max, vec.x)), Math.max(min, Math.min(max, vec.y))); }
export function clampVec3(vec, min, max) { return new THREE.Vector3(Math.max(min, Math.min(max, vec.x)), Math.max(min, Math.min(max, vec.y)), Math.max(min, Math.min(max, vec.z))); }


//abstract class
export class gameObject extends EventTarget
{
    handler = null;
    pos = new THREE.Vector3();
    tags = [];
    isLocal = true;
    sendingData = {};
    lastSentData = {};
    catchUpData = {};
    updateUTime = false;
    constructor(h = null, mesh = null, isLocal = true)
    {
        super();
        this.handler = h;
        this.mesh = mesh ? mesh.clone() : new THREE.Object3D();
        this.isLocal = isLocal;
    }
    tick(dt, time)
    {
        //automatically set any uTime uniforms on materials of meshes
        if(this.updateUTime)
        {
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
        const targ = full || !COMPRESSION[sd.unit].delta ? target : addArrays(start, target);
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
                this.lastSentData[key] = [[],[],false];
                continue;
            }
            const comp = COMPRESSION[sd.unit];
            const sendDelta = !full && comp.delta;
            const lsd = this.lastSentData[key];
            if(lsd == null) //haven't sent anything yet, send full value even if full is false
            {
                data[key] = value;
                this.lastSentData[key] = [value, value, false];
                full = true;
                anyData = true;
            }
            else
            {
                const lastFull = lsd[0];
                const lastSent = lsd[1];
                const lastWasDelta = lsd[2];
                //only send if all is true, if we're sending full and the last sent was a delta, or if the value has changed
                if(all || (full && lastWasDelta) || !value.every((v, i) => v == lastFull[i]))
                {
                    let sentData = value;
                    if(sendDelta)
                        sentData = subArrays(value, lastFull);
                    data[key] = sentData;
                    this.lastSentData[key] = [value, sentData, sendDelta]; //[full value, actual sent data (can be delta or full), bool for if the sent data was a delta]
                    anyData = true;
                }
            }
        }

        if(anyData)
        {
            //make bit field for flags representing full and each sendingDataId present in the sent data
            const flags = new Uint8Array(FLAG_BYTES);
            flags[0] |= full;
            for(const [name, id] of Object.entries(SENDING_DATA_IDS))
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
                const comp = COMPRESSION[this.sendingData[id].unit];
                dataCompression[id] = comp;
                const isDelta = !full && comp.delta;
                const numBytes = isDelta ? comp.bytes / 2 : comp.bytes;
                dataNumBytes[id] = numBytes;
                totalBytes += numBytes * value.length * comp.numValues;
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
                    if(comp.numValues == 1)
                        compressedValue = [compressedValue];
                    for(let cv of compressedValue)
                    {
                        if(comp.clamp)
                            cv = clampByBytes(cv, valueBytes, comp.signed);
                        view[setter](offset, cv);
                        offset += valueBytes;
                    }
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
    onRemove() {}
}


export class collisionGameObject extends gameObject
{
    collider = {
        radius: 0,
        height: 0,
        pos: new THREE.Vector3(),
        static: false,
        active: false,
        worldPos : new THREE.Vector3(),
        top: 0,
        bottom: 0,
        cells: [],
        debugDrawMesh: null
    }
    prevPos = new THREE.Vector3();
    prevYaw =  null;
    changed = false;
    groundLevel = 0;
    constructor(h = null, mesh = null, isLocal = true)
    {
        super(h, mesh, isLocal);
    }
    setCollider(radius, height, bottomPos, isStatic, setActive = true)
    {
        this.setColliderRadius(radius);
        this.setColliderHeight(height);
        this.setColliderPos(new THREE.Vector3(bottomPos.x, bottomPos.y, bottomPos.z + height / 2));
        this.setColliderStatic(isStatic);
        this.setColliderActive(setActive);

        if(this.collider.debugDrawMesh)
            this.setDebugDraw(true);
    }
    setColliderRadius(radius)
    {
        this.collider.radius = radius;
        this.collider.changed = true;
    }
    setColliderHeight(height)
    {
        this.collider.height = height;
        this.collider.changed = true;
    }
    setColliderPos(pos)
    {
        this.collider.pos.copy(pos);
        this.collider.changed = true;
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
            this.handler.collision.addCollider(this);
        else
            this.handler.collision.removeCollider(this);
    }
    updateColliderInfo()
    {
        //update worldPos
        const pos = this.getPos();
        const colPos = this.collider.pos;
        const yaw = this.mesh.rotation.z;
        const result = new THREE.Vector3(
            pos.x + colPos.x * Math.cos(yaw) - colPos.y * Math.sin(yaw),
            pos.y + colPos.x * Math.sin(yaw) + colPos.y * Math.cos(yaw),
            pos.z + colPos.z);
        this.collider.worldPos.copy(result);
        
        //update derrived variables
        this.collider.top = this.collider.worldPos.z + this.collider.height / 2; 
        this.collider.bottom = this.collider.worldPos.z - this.collider.height / 2;

        //update cells
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
                    newCells.push(this.handler.collision.getCellKey({ x: x, y: y, z: z }));
                }
            }
        }

        //populate self in appropriate slots in handler.collision.staticCells map (only if static and active)
        if(this.collider.static && this.collider.active)
        {
            //remove self from old cells
            for(const oldCell of this.collider.cells)
            {
                const newCellInd = newCells.indexOf(oldCell);
                if(newCellInd != -1)
                {
                    newCells.splice(newCellInd, 1);
                    continue;
                }
                const entry = this.handler.collision.staticCells.get(oldCell);
                entry.splice(entry.indexOf(this), 1);
            }
            //add self to new cells
            for(const newCell of newCells)
            {
                const entry = this.handler.collision.staticCells.get(newCell);
                if(!entry)
                {
                    this.handler.collision.staticCells.set(newCell, [this]);
                    continue;
                }
                entry.push(this);
            }
        }

        this.collider.cells = newCells;

        
        //update debug draw cells
        if(this.collider.debugDrawCells != null)
        {
            for(const ddc of this.collider.debugDrawCells)
            {
                this.handler.scene.remove(ddc);
            }
            this.collider.debugDrawCells = [];
            
            const cs = this.handler.collision.cellSize;
            const gridMesh = new THREE.Mesh(
                new THREE.BoxGeometry(cs, cs, cs), 
                new THREE.MeshStandardMaterial({ color: this.collider.static ? "yellow" : "green", transparent: true, opacity: 0.25, depthTest:false, depthWrite:false }));
            for(const c of this.collider.cells)
            {
                const m = gridMesh.clone();
                m.position.copy(this.handler.collision.getCellPos(c).multiplyScalar(2).add(new THREE.Vector3(cs / 2, cs / 2, cs / 2)));
                this.handler.scene.add(m);
                this.collider.debugDrawCells.push(m);
            }
        }
    }
    setDebugDraw(debugDraw)
    {
        if(!debugDraw)
        {
            this.mesh.remove(this.collider.debugDrawMesh);
            this.collider.debugDrawMesh = null;
            if(this.collider.debugDrawCells != null)
            {
                for(const ddc of this.collider.debugDrawCells)
                {
                    this.handler.scene.remove(ddc);
                }
            }
            this.collider.debugDrawCells = null;
        }
        else
        {
            if(this.collider.debugDrawMesh)
                this.setDebugDraw(false);
            this.collider.debugDrawMesh = new THREE.Mesh(
                new THREE.CylinderGeometry(this.collider.radius, this.collider.radius, this.collider.height, 32), 
                new THREE.MeshStandardMaterial({color:"red", transparent:true, opacity:0.5}));
            this.mesh.add(this.collider.debugDrawMesh);
            if(Math.abs(this.mesh.rotation.x) == 0)
                this.collider.debugDrawMesh.rotateX(Math.PI / 2);
            this.collider.debugDrawMesh.position.copy(this.collider.pos);
            this.collider.debugDrawCells = [];
            this.collider.changed = true;
        }
    }
    tick(dt, time)
    {
        super.tick(dt, time);

        const colliderChange = this.collider.changed;
        this.collider.changed = false;

        //see if we should check for collisions
        let checkFromYaw = false;
        if(!colliderChange)
        {
            //need to check from yaw if object yaw changes while collider does not have radial symmetry
            if(this.collider.pos.x != 0 || this.collider.pos.y != 0)
                checkFromYaw = this.mesh.rotation.z != this.prevYaw;
        }
        if(colliderChange || checkFromYaw || (!this.collider.static && this.getPos().sub(this.prevPos).length() > 0))
        {
            this.updateColliderInfo();

            if(this.collider.static || !this.collider.active)
                return;

            //check for collisions from static colliders that share a cell with us
            const collisions = this.checkForCollisionsInCells();
            this.resolveCollisions(collisions);
            this.prevPos.copy(this.getPos());
            this.prevYaw = this.mesh.rotation.z;
        }
    }
    checkForCollisionsInCells()
    {
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
        const me = this.collider;
        const you = gameObj.collider;

        //see if heights intersect
        const verticalOverlap = me.worldPos.z < you.worldPos.z ? me.top - you.bottom : you.top - me.bottom;
        if(verticalOverlap <= 0)
            return false; //heights do not intersect

        //see if radii intersect
        const minDist = me.radius + you.radius;
        const horizontalOverlap = minDist - new THREE.Vector2(me.worldPos.x, me.worldPos.y).sub(new THREE.Vector2(you.worldPos.x, you.worldPos.y)).length();
        if(horizontalOverlap > 0)
            return { horizontalOverlap: horizontalOverlap, verticalOverlap: verticalOverlap, gameObj: gameObj };
        else
            return false;
    }
    getCollisionCorrection(args)
    {
        if(!args)
            return false;

        const me = this.collider;
        const you = args.gameObj.collider;

        //resolve collision through either vertical or horizontal overlap
        const useVertical = args.useHorizontal ? false : args.verticalOverlap < args.horizontalOverlap;
        const diff = useVertical ? 
            new THREE.Vector3(0, 0, me.worldPos.z - you.worldPos.z) : 
            new THREE.Vector3(me.worldPos.x - you.worldPos.x, me.worldPos.y - you.worldPos.y, 0);
        const dir = diff.clone().normalize();

        //assume gameObj is static and we are not
        const correction = dir.clone().multiplyScalar(useVertical ? args.verticalOverlap : args.horizontalOverlap);
        
        //if correction would ever put us below ground level, dont do it and instead use horizontal displacement
        if(useVertical && correction.z + me.bottom < this.groundLevel)
            return this.resolveCollision({ ...args, useHorizontal: true });
        
        return correction;
    }
    resolveCollisions(collisions)
    {
        if(!collisions)
            return;
        if(!Array.isArray(collisions))
            collisions = [collisions];
        else if(collisions.length == 0)
            return;

        //add all corrections in a sum
        const correction = new THREE.Vector3();
        let numVerts = 0;
        let numHors = 0;
        for(const c of collisions)
        {
            const corr = this.getCollisionCorrection(c);
            if(!corr)
                continue;
            if(corr.z != 0)
            {
                numVerts++;
                correction.z += corr.z;
            }
            else
            {
                numHors++;
                correction.x += corr.x;
                correction.y += corr.y;
            }
        }

        //average out all horizontal and vertical corrections
        if(collisions.length > 1)
        {
            if(numHors > 0)
            {
                correction.x /= numHors;
                correction.y /= numHors;
            }
            if(numVerts > 0)
                correction.z /= numVerts;
        }

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