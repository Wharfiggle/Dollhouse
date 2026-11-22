import * as THREE from "three";
import { collisionGameObject, gameObject, 
    MAX_METERS, MAX_METERS_DELTA, KEY_PRESSED, KEY_RELEASED, SENDING_DATA_IDS,
    clampVec2, clampVec3, lerp, lerpVec } from "./GameObject.js";


export const PLACE_TIME = 2;

const POSE_DIRECTIONS = [];
let poseDirectionUp;
let poseDirectionDown;
for(let i = -1; i <= 1; i++)
{
    for(let j = -1; j <= 1; j++)
    {
        for(let k = -1; k <= 1; k++)
        {
            if(i == 0 && j == 0 && k == 0)
                continue;
            else if(i == 0 && k == 0)
            {
                if(j == 1)
                    poseDirectionUp = POSE_DIRECTIONS.length;
                else
                    poseDirectionDown = POSE_DIRECTIONS.length;
            }
            POSE_DIRECTIONS.push(new THREE.Vector3(i, j, k).normalize());
        }
    }
}


//abstract class
export class mannequin extends collisionGameObject
{
    mannequinMesh = null;
    pivots = {};
    pivotReferencePoints = null;
    poseCollision = {
        highest: 0,
        lowest: 0
    };
    pose = null;
    material = null;
    color = "rgb(255, 0, 255)";
    constructor(h, mesh, isLocal, material = null)
    {
        super(h, mesh, isLocal);
        material ??= h.materials.player;
        this.material = material.clone();

        this.setColliderRadius(0.3);
        this.setColliderHeight(1.75);

        this.handler.requestMesh("./assets/PegMan.glb", (scene, animations) => { this.setUpMannequinMesh(scene, animations); });
    }
    setColor(color)
    {
        this.color = new THREE.Color(color);
        this.material.color.set(this.color);
    }
    setUpMannequinMesh(scene, animations)
    {
        this.mannequinMesh = scene;
        this.mannequinMesh.traverse((obj) => {
            if(obj.isMesh)
            {
                obj.material = this.material;
                this.setColor(this.color);
            }
        });
        this.mesh.add(this.mannequinMesh);
        this.mannequinMesh.rotateZ(Math.PI);
        
        let skel;
        scene.traverse(obj => {
            if(obj.isSkinnedMesh)
                skel = obj.skeleton;
        });
        this.pivots.body = skel.getBoneByName("Hip_Bone_00");
        this.pivots.head = skel.getBoneByName("Head_Bone_02");
        this.pivots.leftArm = skel.getBoneByName("Arm_Upper_Bone_L_06");
        this.pivots.rightArm = skel.getBoneByName("Arm_Upper_Bone_R_03");
        this.pivots.leftLeg = skel.getBoneByName("Leg_Upper_Bone_L_09");
        this.pivots.rightLeg = skel.getBoneByName("Leg_Upper_Bone_R_012");

        this.pivotReferencePoints = this.addPivotReferencePoints();
        if(this.pose != null)
            this.applyPoseToPivots(true);
    }
    setPose(pose)
    {
        this.pose = pose;
        if(this.mannequinMesh)
            this.applyPoseToPivots(true);
    }
    applyPoseToPivots(restPose = false)
    {
        for(const [id, piv] of Object.entries(this.pivots))
        {
            const p = this.pose[id];
            piv.quaternion.copy(this.getNewPivotQuat(p.dir, p.roll));
            if(restPose)
            {
                piv.restDir = p.dir;
                if(p.roll != null)
                    piv.restRoll = p.roll;
            }
        }
        this.poseCollision = this.calculatePoseCollision(this.pivotReferencePoints);
        this.setColliderFromPoseCollision(this.poseCollision);
    }
    //calculates pose collision information from reference points
    calculatePoseCollision(pivotReferencePoints)
    {
        const poseCollision = { lowest: Infinity, highest: -Infinity };
        for(const prp of pivotReferencePoints)
        {
            const z = prp.object.getWorldPosition(new THREE.Vector3()).z - this.getPos().z;
            if(z + prp.radius > poseCollision.highest)
                poseCollision.highest = z + prp.radius;
            if(z - prp.radius < poseCollision.lowest)
                poseCollision.lowest = z - prp.radius;
        }
        return poseCollision;
    }
    setColliderFromPoseCollision(poseCollision)
    {
        const pc = poseCollision;
        this.setColliderRadius(0.3);
        this.setColliderHeight(Math.max(0.25, Math.min(2.16, pc.highest - pc.lowest))); //clamp height so cheaters cant make ridiculous bounding boxes
        this.setColliderPos(new THREE.Vector3(0, 0, pc.lowest + this.collider.height / 2));

        if(this.collider.debugDrawMesh)
            this.setDebugDraw(true);
    }
    getNewPivotQuat(dir, roll = null, referenceQuat = null)
    {
        if(dir == null || dir < 0 || dir >= POSE_DIRECTIONS.length)
        {
            console.error("Received invalid pivot direction!");
            return new THREE.Quaternion();
        }

        const quat = new THREE.Quaternion();
        const forward = new THREE.Vector3(0, 1, 0);
        if(referenceQuat != null)
        {
            quat.copy(referenceQuat);
            forward.applyQuaternion(referenceQuat);
        }
        quat.premultiply(new THREE.Quaternion().setFromUnitVectors(forward, POSE_DIRECTIONS[dir]));
        if(roll != null)
            quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), roll * Math.PI / 4));

        return quat;
    }
    //store reference points on pivots
    //used to calculate pose collision
    addPivotReferencePoint(pivotName, pos, radius)
    {
        const rp = new THREE.Object3D();
        this.pivots[pivotName].add(rp);
        rp.position.copy(pos);
        return { pivotName: pivotName, object: rp, radius: radius };
    }
    addPivotReferencePoints()
    {
        const result = [];
        result.push(this.addPivotReferencePoint("rightArm", new THREE.Vector3(0, 0, 0),     0.1));
        result.push(this.addPivotReferencePoint("rightArm", new THREE.Vector3(0, 6.8, 0),   0.075));
        result.push(this.addPivotReferencePoint("leftArm", new THREE.Vector3(0, 0, 0),      0.1));
        result.push(this.addPivotReferencePoint("leftArm", new THREE.Vector3(0, 6.8, 0),    0.075));
        result.push(this.addPivotReferencePoint("rightLeg", new THREE.Vector3(0, 0, 0),     0.1));
        result.push(this.addPivotReferencePoint("rightLeg", new THREE.Vector3(0, 7, 0),     0.075));
        result.push(this.addPivotReferencePoint("leftLeg", new THREE.Vector3(0, 0, 0),      0.1));
        result.push(this.addPivotReferencePoint("leftLeg", new THREE.Vector3(0, 7, 0),      0.075));
        result.push(this.addPivotReferencePoint("head", new THREE.Vector3(0, 0.65, 0),      0.125));
        return result;
    }
}

export class player extends mannequin
{
    speed = 3;
    climbSpeed = 1;
    touchMove = {
        stickRadius: 50,
        maxDist: 100,
        outerRadius: 0,
        identifier: null,
        start: null
    }
    touchLookIdentifier = null;
    placeProgress = 0;
    placeWaitForRelease = false;
    climbCollider = null;
    climbing = false;
    cameraOrbit = new THREE.Object3D();
    cameraRoot = new THREE.Object3D();
    id = 0;
    controlled = false;
    moveInput = new THREE.Vector2();
    meshYaw = 0;
    meshTargetYaw = 0;
    gravity = 0;
    grounded = false;
    placedDoll = null;
    insidePlacedDoll = false;
    openMenu = false;
    cameraMenuTransition = {
        offset: 1.8,
        t: 0,
        targetOrbitQuat: null,
        targetMeshQuat: null
    };
    pose = {
        body: { dir:poseDirectionUp, roll:0 },
        head: { dir:poseDirectionUp },
        leftArm: { dir:poseDirectionDown },
        rightArm: { dir:poseDirectionDown },
        leftLeg: { dir:poseDirectionDown },
        rightLeg: { dir:poseDirectionDown }
    };
    lockYawToCamera = false;

    constructor(args)
    {
        super(args.handler, new THREE.Object3D(), Object.hasOwn(args, "isLocal") ? args.isLocal : true, args.handler.materials.player);

        this.touchMove.outerRadius = this.touchMove.stickRadius + this.touchMove.maxDist;

        this.mesh.add(this.cameraOrbit);
        this.cameraOrbit.add(this.cameraRoot);
        this.cameraOrbit.position.set(0, 0, 1);
        this.cameraRoot.position.set(0, -3, 3);
        this.cameraRoot.rotateX(-Math.PI / 4);

        this.id = args.id ?? 0;
        this.handler.multiplayer.addPlayer(this, this.id);

        this.setPos(args.startPos ?? new THREE.Vector3(0, 0, 10));

        
        this.addSendingData(SENDING_DATA_IDS.xy, "meters",
            () => [this.pos.x, this.pos.y], 
            (toFormat) => new THREE.Vector2().fromArray(toFormat),
            (data, t) => {
                const xy = lerpVec(data.start, data.target, t);
                this.setPos(new THREE.Vector3(xy.x, xy.y, this.pos.z));
                return t >= 1;
            });
        this.addSendingData(SENDING_DATA_IDS.z, "metersNoDelta",
            () => [this.getPos().z], 
            (toFormat) => toFormat[0],
            (data, t) => {
                this.setPos(new THREE.Vector3(this.pos.x, this.pos.y, lerp(data.start, data.target, t)));
                return t >= 1;
            });


        this.addSendingData(SENDING_DATA_IDS.targetYaw, "radians",
            () => [this.meshTargetYaw],
            (toFormat) => toFormat[0],
            (data) => {
                this.meshTargetYaw = data.target;
                return true;
            });

        
        this.addSendingData(SENDING_DATA_IDS.poseBody, "", 
            () => [this.pose.body.dir, this.pose.body.roll],
            (toFormat) => { return { dir: toFormat[0], roll: toFormat[1] }; },
            (data) => {
                this.setPivotDirection("body", data.target.dir, data.target.roll);
                return true;
            });
        for(let i = SENDING_DATA_IDS.poseHead; i <= SENDING_DATA_IDS.poseRightLeg; i++)
        {
            const poseInd = i - SENDING_DATA_IDS.poseBody;
            this.addSendingData(i, "", 
                () => [Object.values(this.pose)[poseInd].dir],
                (toFormat) => toFormat[0],
                (data) => {
                    const key = Object.keys(this.pose)[poseInd];
                    this.setPivotDirection(key, data.target);
                    return true;
                });
        }

        this.addSendingData(SENDING_DATA_IDS.color, "color",
            () => [this.color],
            (toFormat) => toFormat[0],
            (data) => {
                this.setColor(data.target);
                return true;
            }
        )


        this.addSendingData(SENDING_DATA_IDS.placedDollPos, "metersNoDelta",
            () => { return this.placedDoll == null ? Array(3) : this.placedDoll.getPos().toArray(); },
            (toFormat) => { return toFormat[0] == null ? null : new THREE.Vector3(toFormat[0], toFormat[1], toFormat[2]); },
            (data) => {
                this.placedDoll = this.handler.newGameObject(placedDoll, { pos: data.target, isLocal: false });
                return true;
            });
        this.addSendingData(SENDING_DATA_IDS.placedDollYaw, "radians",
            () => { return this.placedDoll == null ? [null] : [this.placedDoll.mesh.rotation.z]; },
            (toFormat) => toFormat[0],
            (data) => {
                this.placedDoll.mesh.rotation.set(0, 0, data.target);
                return true;
            });
        this.addSendingData(SENDING_DATA_IDS.placedDollColor, "color",
            () => { return this.placedDoll == null ? Array(1) : [this.placedDoll.color]; },
            (toFormat) => toFormat[0],
            (data) => {
                this.placedDoll.color = data.target;
                return true;
            }
        )
        this.addSendingData(SENDING_DATA_IDS.placedDollPose, "",
            () => { return this.placedDoll == null ? Array(7) : Object.values(this.placedDoll.pose).flatMap(e => Object.values(e)); },
            (toFormat) => toFormat,
            (data) => {
                const p = data.target;
                this.placedDoll.setPose({
                    body: { dir: p[0], roll: p[1] },
                    head: { dir: p[2] },
                    leftArm: { dir: p[3] },
                    rightArm: { dir: p[4] },
                    leftLeg: { dir: p[5] },
                    rightLeg: { dir: p[6] }
                });
                return true;
            });
    }
    setUpMannequinMesh(scene, animations)
    {
        super.setUpMannequinMesh(scene, animations);
        
        this.mesh.remove(this.mannequinMesh);
        this.handler.scene.add(this.mannequinMesh);
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
    setControlled(controlled)
    {
        if(controlled)
        {
            this.cameraRoot.add(this.handler.camera);
            this.handler.camera.position.set(0, 0, 0);
            this.handler.camera.rotation.set(Math.PI / 2, 0, 0);

            this.setColliderActive(true);
            this.climbCollider = new collisionGameObject(this.handler);

            //lock mouse when page is clicked, but only if menu is not open
            this.ui.canvas.addEventListener("click", (event) => { this.setOpenMenu(false); });

            //event received from index.html when pose menu arrow buttons are pressed
            document.addEventListener("pivotTurn", (event) => {
                const d = event.detail;
                //determine axis and direction
                const mod = (d.turnDir == "right" || d.turnDir == "down" || d.turnDir == "cw") ? 1 : -1;
                const axis = new THREE.Vector3();
                if(d.turnDir == "up" || d.turnDir == "down")
                    axis.x = -1;
                else if(d.turnDir == "left" || d.turnDir == "right")
                    axis.y = 1;
                else
                    axis.z = 1;

                //apply rotation on given axis
                const pivot = this.pivots[d.pivot];
                //on limbs, rotate axis to cancel out body's rotations so that rotation direction is still consistent
                if(d.pivot != "body")
                    axis.applyQuaternion(this.pivots.body.quaternion.clone().invert());
                const quat = pivot.quaternion.clone().premultiply(new THREE.Quaternion().setFromAxisAngle(axis, mod * Math.PI / 4));

                //get closest direction in 26 voxel neighborhood and snap to it
                const forward = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
                let bestDot = 0;
                let dirInd = 0;
                for(const [i, dir] of POSE_DIRECTIONS.entries())
                {
                    const dot = forward.dot(dir);
                    if(dot > bestDot)
                    {
                        bestDot = dot;
                        dirInd = i;
                    }
                }
                const direction = POSE_DIRECTIONS[dirInd];
                quat.premultiply(new THREE.Quaternion().setFromUnitVectors(forward, direction));

                //snap roll to 45 degree increments
                const projected = quat.x * direction.x + quat.y * direction.y + quat.z * direction.z;
                let roll = 2 * Math.atan2(projected, quat.w);
                //make sure roll is within range of 0 - 2PI
                roll = ((roll % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);
                const snappedRollInd = Math.round(roll / (Math.PI / 4));
                const snappedRoll = snappedRollInd * (Math.PI / 4);
                quat.premultiply(new THREE.Quaternion().setFromAxisAngle(direction, snappedRoll - roll));
                
                this.setPivotDirection(d.pivot, dirInd, d.pivot == "body" ? snappedRollInd : null); //, quat)
            });

            //todo fix this not changing collider
            //event received from index.html when reset button is pressed
            document.addEventListener("pivotReset", (event) => {
                for(const [id, piv] of Object.entries(this.pivots))
                {
                    this.setPivotDirection(id, piv.restDir, piv.restRoll);
                }
            });

            //event received from index.html when color is changed
            document.addEventListener("colorChange", (event) => {
                this.setColor(event.detail.color);
            });

            this.handler.input.subscribeToTouch(this, KEY_PRESSED, (e) => {
                this.setOpenMenu(false);
                if(e.coord.x < 0)
                {
                    if(!this.touchMove.start)
                    {
                        this.touchMove.identifier = e.touchIdentifier;
                        const outr = this.touchMove.outerRadius * this.ui.wScale;
                        this.touchMove.start = new THREE.Vector2(
                            Math.max(outr, Math.min(this.ui.canvas.width - outr, e.pos.x)),
                            Math.max(outr, Math.min(this.ui.canvas.height - outr, e.pos.y))
                        );
                    }
                }
                else if(this.touchLookIdentifier == null)
                    this.touchLookIdentifier = e.touchIdentifier;
            });
            this.handler.input.subscribeToTouch(this, KEY_RELEASED, (e) => {
                if(e.touchIdentifier == this.touchMove.identifier)
                {
                    this.touchMove.identifier = null;
                    this.touchMove.start = null;
                    this.moveInput = new THREE.Vector2();
                }
                else if(e.touchIdentifier == this.touchLookIdentifier)
                    this.touchLookIdentifier = null;
            })
            this.handler.input.subscribeToCursorMove(this, (e) => {
                if(this.openMenu)
                    return;
                if(e.touchIdentifier != null && e.touchIdentifier == this.touchMove.identifier)
                {
                    const delta = this.touchMove.start.clone().sub(e.pos);
                    this.moveInput = new THREE.Vector2(-delta.x, delta.y);
                    this.moveInput.clampLength(0, this.touchMove.maxDist * this.ui.wScale);
                }
                else if(e.touchIdentifier == this.touchLookIdentifier)
                {
                    if(e.touchIdentifier == null && this.ui.canvas != document.pointerLockElement)
                        return;

                    this.mesh.rotateZ(-4 * e.deltaPos.x / this.ui.height);
                    this.cameraOrbit.rotateX(-4 * e.deltaPos.y / this.ui.height);
                    //clamp camera to not roll backwards
                    this.cameraOrbit.rotation.x = Math.max(-Math.PI * 0.25, Math.min(Math.PI * 0.65, this.cameraOrbit.rotation.x));

                    if(this.lockYawToCamera)
                        this.setMeshYaw(this.mesh.rotation.z);
                }
            });
            this.handler.input.subscribeToButton(this, "e", KEY_RELEASED, () => {
                if(this.placeWaitForRelease)
                    this.placeWaitForRelease = false;
            });
            this.handler.input.subscribeToButton(this, "q", KEY_PRESSED, () => { this.setOpenMenu(!this.openMenu); });
                
            this.handler.input.subscribeToButton(this, " ", KEY_PRESSED, () => {
                if(this.openMenu)
                    return;
                this.climbing = true; 
            });
            this.handler.input.subscribeToButton(this, " ", KEY_RELEASED, () => { this.climbing = false; });
            this.handler.input.subscribeToButton(this, "rightmouse", KEY_PRESSED, () => { 
                this.setMeshYaw(this.mesh.rotation.z);
                this.lockYawToCamera = true;
            });
            this.handler.input.subscribeToButton(this, "rightmouse", KEY_RELEASED, () => { this.lockYawToCamera = false; });
            
            //TODO: remove, debug
            this.handler.input.subscribeToButton(this, "`", KEY_PRESSED, () => { this.handler.collision.setDebugDraw(!this.handler.collision.debugDraw); });
        }
        else
        {
            this.ui.canvas.removeEventListener("click");
            document.removeEventListener("pivotTurn");
            document.removeEventListener("pivotReset");
            document.removeEventListener("colorChange");
            this.handler.input.unsubscribeFromAllInput(this);
        }
    }
    tick(dt, time)
    {
        //slerp pivots towards target rotation 
        for(const [id, piv] of Object.entries(this.pivots))
        {
            if(piv.target)
            {
                piv.t ??= 0;
                piv.t = Math.min(1, piv.t + dt * 2);
                piv.quaternion.slerp(piv.target, Math.sqrt(piv.t));
                if(piv.t >= 1)
                {
                    piv.target = null;
                    piv.t = 0;
                }
            }
        }

        if(!this.isLocal)
        {
            if(this.mannequinMesh)
            {
                this.rotateMeshTowardsTargetYaw(dt);
                this.mannequinMesh.position.copy(this.getPos());
            }
            return;
        }

        //calculate movement direction
        const moveKey = new THREE.Vector2();
        if(this.handler.input.isHeld("w")) moveKey.y += 1;
        if(this.handler.input.isHeld("s")) moveKey.y -= 1;
        if(this.handler.input.isHeld("d")) moveKey.x += 1;
        if(this.handler.input.isHeld("a")) moveKey.x -= 1;
        moveKey.normalize();
        const moveIn = moveKey.add(this.moveInput.clone().divideScalar(this.touchMove.maxDist * this.ui.wScale));
        if(!this.openMenu && moveIn.length() > 0)
        {
            const forwardVector = new THREE.Vector3(0, 1, 0); //we consider the positive y direction to be forward
            forwardVector.applyQuaternion(this.mesh.quaternion);
            const ang = Math.atan2(moveIn.y, moveIn.x) - Math.PI / 2;
            //rotate forwardVector by angle of moveInput to get movement direction
            const movement = new THREE.Vector3(
                Math.cos(ang) * forwardVector.x - Math.sin(ang) * forwardVector.y,
                Math.sin(ang) * forwardVector.x + Math.cos(ang) * forwardVector.y,
                0
            )

            this.addPos(movement.multiplyScalar(this.speed * dt * Math.min(1, moveIn.length())));
            
            if(!this.lockYawToCamera)
            {
                this.meshTargetYaw = Math.atan2(movement.y, movement.x) - Math.PI / 2;
                this.rotateMeshTowardsTargetYaw(dt);
            }
        }
        else if(this.mannequinMesh)
            this.meshTargetYaw = this.mannequinMesh.rotation.z;

        if(this.climbing)
        {
            const pos = this.getPos();
            this.climbCollider.setPos(pos);
            this.climbCollider.mesh.rotation.z = this.mesh.rotation.z;
            const bottomPos = new THREE.Vector3(this.collider.pos.x, this.collider.pos.y, this.collider.pos.z - this.collider.height / 2);
            this.climbCollider.setCollider(this.collider.radius + 0.25, this.collider.height + 0.2, bottomPos, false, false);
            this.climbCollider.updateColliderInfo();
            if(this.insidePlacedDoll || this.climbCollider.checkForCollisionsInCells().length > 0)
            {
                this.grounded = true;
                this.gravity = 0;
                this.setPos(new THREE.Vector3(pos.x, pos.y, pos.z + this.climbSpeed * dt));
            }
        }

        //gravity
        const effz = this.pos.z + this.collider.pos.z - this.collider.height / 2;
        if(!this.grounded && effz != this.groundLevel)
        {
            this.gravity = Math.min(MAX_METERS_DELTA * (1 / 60 / this.handler.multiplayer.sendInterval), this.gravity + dt);
            const newEffz = Math.max(this.groundLevel, effz - this.gravity);
            this.setPos(new THREE.Vector3(this.pos.x, this.pos.y, newEffz - this.collider.pos.z + this.collider.height / 2));

            if(newEffz <= this.groundLevel)
            {
                this.grounded = true;
                this.gravity = 0;
            }
        }

        this.setPos(clampVec3(this.getPos(), -MAX_METERS, MAX_METERS));

        //hold place button for full duration then place doll
        if(this.handler.input.isHeld("e") && !this.openMenu && this.mannequinMesh && !this.insidePlacedDoll && !this.placeWaitForRelease)
        {
            this.placeProgress += dt;

            if(this.placeProgress > PLACE_TIME)
            {
                this.placedDoll = this.handler.newGameObject(placedDoll, {
                    pos: this.getPos(), 
                    yaw: this.meshYaw - Math.PI,
                    pose: this.pose,
                    color: this.color,
                    isLocal: true 
                });
                this.insidePlacedDoll = true;
                this.placeWaitForRelease = true;
                this.placeProgress = 0;
            }
        }
        else if(this.placeProgress > 0)
            this.placeProgress = Math.max(0, this.placeProgress - dt);


        //calculate camera offsets and rotations beased on cameraMenuTransition
        const cmt = this.cameraMenuTransition;
        const transition = this.openMenu ? 1 : -1;
        const prevT = cmt.t;
        cmt.t = Math.max(0, Math.min(1, cmt.t + transition * dt * 2));
        const menuOffset = -this.handler.camera.aspect * cmt.t * cmt.offset;
        this.handler.camera.position.set(menuOffset, 0, 0);

        if(this.mannequinMesh && this.openMenu && prevT < 1)
        {
            this.cameraOrbit.quaternion.slerp(cmt.targetOrbitQuat, Math.pow(cmt.t, 2));
            this.mannequinMesh.quaternion.slerp(cmt.targetMeshQuat, Math.pow(cmt.t, 2));
            this.setMeshYaw(this.mannequinMesh.rotation.z);
        }

        //camera pole arm, dont let camera go below floor
        const cameraWorldPos = new THREE.Vector3();
        this.cameraRoot.getWorldPosition(cameraWorldPos);
        const cameraGround = this.groundLevel + 0.05;
        if(cameraWorldPos.z < cameraGround)
        {
            const orbitWorldPos = new THREE.Vector3();
            this.cameraOrbit.getWorldPosition(orbitWorldPos);
            const direction = cameraWorldPos.clone().sub(orbitWorldPos);
            const lengthMod = (cameraGround - orbitWorldPos.z) / direction.z;
            const targetWorldPos = orbitWorldPos.clone().add(direction.clone().multiplyScalar(lengthMod));
            this.handler.camera.position.copy(this.cameraRoot.worldToLocal(targetWorldPos));
            this.handler.camera.position.x = menuOffset * lengthMod;
        }

        //draw touch move stick
        if(this.touchMove.start)
        {
            this.ui.lineWidth = 5 * this.ui.wScale;
            this.ui.strokeStyle = "rgba(0, 0, 0, 0.5)";
            this.ui.beginPath();
            this.ui.arc(this.touchMove.start.x + this.moveInput.x, this.touchMove.start.y - this.moveInput.y, this.touchMove.stickRadius * this.ui.wScale, 0, 2 * Math.PI);
            this.ui.stroke();
            this.ui.lineWidth = 3 * this.ui.wScale;
            this.ui.beginPath();
            this.ui.arc(this.touchMove.start.x, this.touchMove.start.y, this.touchMove.outerRadius * this.ui.wScale, 0, 2 * Math.PI);
            this.ui.stroke();
        }

        //draw place progress bar
        if(this.placeProgress > 0)
        {
            this.ui.lineWidth = 15 * this.ui.hScale;
            this.ui.strokeStyle = "rgba(50, 75, 50, 0.8)";
            this.ui.beginPath();
            this.ui.arc(this.ui.width / 2, this.ui.height / 2, 60 * this.ui.hScale, 0, 2 * Math.PI);
            this.ui.stroke();
            this.ui.strokeStyle = "rgba(205, 255, 205, 0.8)";
            this.ui.beginPath();
            this.ui.arc(this.ui.width / 2, this.ui.height / 2, 60 * this.ui.hScale, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * this.placeProgress / PLACE_TIME);
            this.ui.stroke();
        }

        super.tick();
        if(this.mannequinMesh)
            this.mannequinMesh.position.copy(this.getPos());
    }
    rotateMeshTowardsTargetYaw(dt)
    {
        if(this.mannequinMesh)
        {
            const targetQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, this.meshTargetYaw, "XYZ"));
            if(this.mannequinMesh.quaternion.angleTo(targetQuat) < 0.05)
                this.mannequinMesh.quaternion.copy(targetQuat);
            else
                this.mannequinMesh.quaternion.slerp(targetQuat, 10 * dt);
            this.meshYaw = this.mannequinMesh.rotation.z;
        }
        else
            this.meshYaw = this.meshTargetYaw;
    }
    setMeshYaw(yaw)
    {
        this.meshTargetYaw = yaw;
        this.meshYaw = yaw;
        this.mannequinMesh.rotation.z = yaw;
    }
    setPivotDirection(pivotName, dir, roll = null, quat = null)
    {
        this.pose[pivotName] = { dir: dir };
        if(roll != null)
            this.pose[pivotName].roll = roll;
        const pivot = this.pivots[pivotName];

        const targetQuat = quat != null ? quat : this.getNewPivotQuat(dir, roll, pivot.quaternion);
        const origQuat = pivot.quaternion.clone();
        pivot.quaternion.copy(targetQuat);
        
        if(this.mannequinMesh != null)
        {
            const prevLowest = this.poseCollision.lowest;
            const prevHighest = this.poseCollision.highest;
            this.poseCollision = this.calculatePoseCollision(this.pivotReferencePoints);
            if(prevLowest != this.poseCollision.lowest || prevHighest != this.poseCollision.highest)
                this.setColliderFromPoseCollision(this.poseCollision);
        }

        pivot.quaternion.copy(origQuat);
        pivot.target = targetQuat;
        pivot.t = 0;
    }
    setOpenMenu(open)
    {
        if(this.openMenu == open)
        {
            if(!open && !document.pointerLockElement)
                this.ui.canvas.requestPointerLock();
            return;
        }
        this.openMenu = open;
        const menuBox = document.getElementById("menuBox");
        if(this.openMenu)
        {
            const cmt = this.cameraMenuTransition;
            cmt.targetOrbitQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI * 0.25, 0, 0, "XYZ"));
            cmt.targetMeshQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, this.mesh.rotation.z + Math.PI * 0.85, "XYZ"));
            document.exitPointerLock();
            menuBox.classList.remove("hidden");
        }
        else
        {
            this.ui.canvas.requestPointerLock();
            menuBox.classList.add("hidden");
        }
    }
    onCollision(correction)
    {
        super.onCollision(correction);
        if(correction.z > 0)
        {
            this.grounded = true;
            this.gravity = 0;
        }
    }
    onRemove() { this.handler.scene.remove(this.mannequinMesh); }
    updateColliderInfo()
    {
        super.updateColliderInfo();
        this.grounded = false;
    }
    setDebugDraw(debugDraw)
    {
        super.setDebugDraw(debugDraw);
        if(this.pivotReferencePoints)
        {
            for(const rp of this.pivotReferencePoints)
            {
                if(debugDraw)
                {
                    rp.debugDrawMesh = new THREE.Mesh(
                        new THREE.IcosahedronGeometry(rp.radius * 10,3), 
                        new THREE.MeshStandardMaterial({color:"green", transparent:true, opacity:0.5, depthTest:false, depthWrite:false}));
                    rp.object.add(rp.debugDrawMesh);
                }
                else
                    rp.object.remove(rp.debugDrawMesh);
            }
        }
    }
}


export class placedDoll extends mannequin
{
    activePlayer;
    solid = false;
    constructor(args)
    {
        super(args.handler, new THREE.Object3D(), args.isLocal, args.handler.materials.placedDoll);

        this.setColliderStatic(true);

        this.activePlayer = this.handler.multiplayer.getControlledPlayer();
        this.setPos(args.pos);
        if(args.yaw)
            this.mesh.rotation.z = args.yaw;
        if(args.color)
            this.color = args.color;
        if(args.pose)
          this.setPose(args.pose);
    }
    tick(dt, time)
    {
        super.tick(dt, time);

        if(this.mannequinMesh && !this.solid && !this.checkForCollision(this.activePlayer))
        {
            this.activePlayer.insidePlacedDoll = false;
            this.solid = true;
            this.setColliderActive(true);
            this.material.copy(this.handler.materials.player);
            this.setColor(this.color);
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