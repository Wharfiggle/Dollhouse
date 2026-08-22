import * as THREE from "three";

const shaderFunctions = {
    
}

//called by first modular onBeforeCompile shader modifier
function establishOnBeforeCompileChain(material, features) //features: array of strings
{
    material.userData.onBeforeCompileList = [];

    //replace cache key so compiler doesnt assume shaders with different modifications are the same
    material.userData.cacheKey = "";
    material.customProgramCacheKey = () => { return material.userData.cacheKey; }
    
    material.onBeforeCompile = (shader) => {
        if(features.includes("uTime"))
        {
            shader.uniforms.uTime = { value: 0 };
            shader.vertexShader = `uniform float uTime;
                ` + shader.vertexShader;
            shader.fragmentShader = `uniform float uTime;
                ` + shader.fragmentShader;
        }

        const onbcl = material.userData.onBeforeCompileList;
        for(var i = 0; i < onbcl.length; i++)
        {
            onbcl[i](shader);
        }

        //store for later access
        material.userData.shader = shader;
    };

    return material;
}


//set up meshes
export function getMeshes(args)
{
    const meshes = {
        player: new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshStandardMaterial({ color: "purple" })
        ),
        playerHead: new THREE.Mesh(
            new THREE.ConeGeometry(0.25, 0.5, 4),
            new THREE.MeshStandardMaterial({ color: "purple" })
        ),
        ground: new THREE.Mesh(
            new THREE.PlaneGeometry(20, 20),
            new THREE.MeshStandardMaterial({ color:"white", side: THREE.DoubleSide })
        )
    }

    return meshes;
}