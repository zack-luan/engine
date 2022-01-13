import React from 'react';
// @ts-ignore: library file import
import * as pc from '../../../../';

import { AssetLoader } from '../../app/helpers/loader';

class ClusteredLightingExample {
    static CATEGORY = 'Graphics';
    static NAME = 'Clustered Lighting';
    static ENGINE = 'PERFORMANCE';

    load() {
        return <>
            <AssetLoader name='script' type='script' url='static/scripts/camera/orbit-camera.js' />
            <AssetLoader name='normal' type='texture' url='static/assets/textures/normal-map.png' />
        </>;
    }

    example(canvas: HTMLCanvasElement, assets: { normal: pc.Asset }): void {

        // Create the application and start the update loop
        const app = new pc.Application(canvas, {});

        const pointLightList: Array<pc.Entity> = [];
        const spotLightList: Array<pc.Entity> = [];
        let dirLight: pc.Entity = null;

        app.start();

        // enabled clustered lighting. This is a temporary API and will change in the future
        // @ts-ignore engine-tsd
        app.scene.clusteredLightingEnabled = true;

        // adjust default clustered lighting parameters to handle many lights:
        const lighting = app.scene.lighting;

        // 1) subdivide space with lights into this many cells:
        // @ts-ignore engine-tsd
        lighting.cells = new pc.Vec3(12, 16, 12);

        // 2) and allow this many lights per cell:
        // @ts-ignore engine-tsd
        lighting.maxLightsPerCell = 48;

        // @ts-ignore engine-tsd
        lighting.shadowsEnabled = false;

        // Set the canvas to fill the window and automatically change resolution to be the same as the canvas size
        app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
        app.setCanvasResolution(pc.RESOLUTION_AUTO);

        window.addEventListener("resize", function () {
            app.resizeCanvas(canvas.width, canvas.height);
        });

        // material with tiled normal map
        let material = new pc.StandardMaterial();
        material.normalMap = assets.normal.resource;
        material.normalMapTiling.set(5, 5);
        material.bumpiness = 1;

        // enable specular
        material.shininess = 50;
        material.metalness = 0.3;
        material.useMetalness = true;

        material.update();

        // ground plane
        const ground = new pc.Entity();
        ground.addComponent('render', {
            type: "plane",
            material: material
        });
        ground.setLocalScale(150, 150, 150);
        app.root.addChild(ground);

        // high polycount cylinder
        const cylinderMesh = pc.createCylinder(app.graphicsDevice, { capSegments: 200 });
        const cylinder = new pc.Entity();
        cylinder.addComponent('render', {
            material: material,
            meshInstances: [new pc.MeshInstance(cylinderMesh, material)],
            castShadows: true
        });
        app.root.addChild(cylinder);
        cylinder.setLocalPosition(0, 50, 0);
        cylinder.setLocalScale(50, 100, 50);

        // create many omni lights that do not cast shadows
        let count = 30;
        const intensity = 1.6;
        for (let i = 0; i < count; i++) {
            const color = new pc.Color(intensity * Math.random(), intensity * Math.random(), intensity * Math.random(), 1);
            const lightPoint = new pc.Entity();
            lightPoint.addComponent("light", {
                type: "omni",
                color: color,
                range: 12,
                castShadows: false
            });

            // attach a render component with a small sphere to each light
            const material = new pc.StandardMaterial();
            material.emissive = color;
            material.update();

            lightPoint.addComponent('render', {
                type: "sphere",
                material: material,
                castShadows: true
            });
            lightPoint.setLocalScale(5, 5, 5);

            // add it to the scene and also keep it in an array
            app.root.addChild(lightPoint);
            pointLightList.push(lightPoint);
        }

        // create many spot lights
        count = 16;
        for (let i = 0; i < count; i++) {
            const color = new pc.Color(intensity * Math.random(), intensity * Math.random(), intensity * Math.random(), 1);
            const lightSpot = new pc.Entity();
            lightSpot.addComponent("light", {
                type: "spot",
                color: color,
                innerConeAngle: 5,
                outerConeAngle: 6 + Math.random() * 40,
                range: 25,
                castShadows: false
            });

            // attach a render component with a small cone to each light
            material = new pc.StandardMaterial();
            material.emissive = color;
            material.update();

            lightSpot.addComponent('render', {
                type: "cone",
                material: material
            });
            lightSpot.setLocalScale(5, 5, 5);

            lightSpot.setLocalPosition(100, 50, 70);
            lightSpot.lookAt(new pc.Vec3(100, 60, 70));
            app.root.addChild(lightSpot);
            spotLightList.push(lightSpot);
        }

        // Create a single directional light which casts shadows
        dirLight = new pc.Entity();
        dirLight.addComponent("light", {
            type: "directional",
            color: pc.Color.WHITE,
            intensity: 0.2,
            range: 300,
            shadowDistance: 600,
            castShadows: true,
            shadowBias: 0.2,
            normalOffsetBias: 0.05
        });
        app.root.addChild(dirLight);

        // Create an entity with a camera component
        const camera = new pc.Entity();
        camera.addComponent("camera", {
            clearColor: new pc.Color(0.05, 0.05, 0.05),
            farClip: 500,
            nearClip: 0.1
        });
        camera.setLocalPosition(140, 140, 140);
        camera.lookAt(new pc.Vec3(0, 40, 0));

        // add orbit camera script with mouse and touch support
        camera.addComponent("script");
        camera.script.create("orbitCamera", {
            attributes: {
                inertiaFactor: 0.2,
                focusEntity: app.root,
                distanceMax: 400,
                frameOnStart: false
            }
        });
        camera.script.create("orbitCameraInputMouse");
        camera.script.create("orbitCameraInputTouch");
        app.root.addChild(camera);

        // Set an update function on the app's update event
        let time = 0;
        app.on("update", function (dt: number) {
            time += dt;

            // move lights along sin based waves around the cylinder
            pointLightList.forEach(function (light, i) {
                const angle = (i / pointLightList.length) * Math.PI * 2;
                const y = Math.sin(time * 0.5 + 7 * angle) * 30 + 70;
                light.setLocalPosition(30 * Math.sin(angle), y, 30 * Math.cos(angle));
            });

            // rotate spot lights around
            spotLightList.forEach(function (spotlight, i) {
                const angle = (i / spotLightList.length) * Math.PI * 2;
                spotlight.setLocalPosition(40 * Math.sin(time + angle), 5, 40 * Math.cos(time + angle));
                spotlight.lookAt(pc.Vec3.ZERO);
                spotlight.rotateLocal(90, 0, 0);
            });

            // rotate directional light
            if (dirLight) {
                dirLight.setLocalEulerAngles(25, -30 * time, 0);
            }
        });
    }
}

export default ClusteredLightingExample;
