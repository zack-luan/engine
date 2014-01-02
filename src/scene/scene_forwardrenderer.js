pc.extend(pc.scene, function () {

    function sortDrawCalls(drawCallA, drawCallB) {
        if (drawCallA.distSqr && drawCallB.distSqr) {
            return drawCallB.distSqr - drawCallA.distSqr;
        } else {
            return drawCallB.key - drawCallA.key;
        }
    }

    // Global shadowmap resources
    var scale = new pc.Matrix4().scale(0.5, 0.5, 0.5);
    var shift = new pc.Matrix4().translate(0.5, 0.5, 0.5);
    var scaleShift = new pc.Matrix4().copy(shift).mul(scale);

    // Lights look down the negative Y and camera's down the positive Z so rotate by -90
    var camToLight = new pc.Matrix4().rotate(-90, pc.Vector3.right);
    var shadowCamWtm = new pc.Matrix4();
    var shadowCamView = new pc.Matrix4();
    var shadowCamViewProj = new pc.Matrix4();

    var viewMat = new pc.Matrix4();
    var viewProjMat = new pc.Matrix4();

    // The 8 points of the camera frustum transformed to light space
    var frustumPoints = [];
    for (i = 0; i < 8; i++) {
        frustumPoints.push(new pc.Vector3());
    }

    function _calculateSceneAabb(scene) {
        var meshInstances = scene.meshInstances;
        if (meshInstances.length > 0) {
            scene._sceneAabb.copy(meshInstances[0].aabb);
            for (var i = 1; i < meshInstances.length; i++) {
                scene._sceneAabb.add(meshInstances[i].aabb);
            }
        }
    }

    function _getFrustumPoints(camera, points) {
        var cam = camera;
        var nearClip   = cam.getNearClip();
        var farClip    = cam.getFarClip();
        var fov        = cam.getFov() * Math.PI / 180.0;
        var aspect     = cam.getAspectRatio();
        var projection = cam.getProjection();

        var x, y;
        if (projection === pc.scene.Projection.PERSPECTIVE) {
            y = Math.tan(fov / 2.0) * nearClip;
        } else {
            y = this._orthoHeight;
        }
        x = y * aspect;

        points[0][0] = x;
        points[0][1] = -y;
        points[0][2] = -nearClip;
        points[1][0] = x;
        points[1][1] = y;
        points[1][2] = -nearClip;
        points[2][0] = -x;
        points[2][1] = y;
        points[2][2] = -nearClip;
        points[3][0] = -x;
        points[3][1] = -y;
        points[3][2] = -nearClip;

        if (projection === pc.scene.Projection.PERSPECTIVE) {
            y = Math.tan(fov / 2.0) * farClip;
            x = y * aspect;
        }
        points[4][0] = x;
        points[4][1] = -y;
        points[4][2] = -farClip;
        points[5][0] = x;
        points[5][1] = y;
        points[5][2] = -farClip;
        points[6][0] = -x;
        points[6][1] = y;
        points[6][2] = -farClip;
        points[7][0] = -x;
        points[7][1] = -y;
        points[7][2] = -farClip;

        return points;
    }

    //////////////////////////////////////
    // Shadow mapping support functions //
    //////////////////////////////////////
    function createShadowMap(device, width, height) {
        var shadowMap = new pc.gfx.Texture(device, {
            format: pc.gfx.PIXELFORMAT_R8_G8_B8_A8,
            width: width,
            height: height
        });
        shadowMap.minFilter = pc.gfx.FILTER_NEAREST;
        shadowMap.magFilter = pc.gfx.FILTER_NEAREST;
        shadowMap.addressU = pc.gfx.ADDRESS_CLAMP_TO_EDGE;
        shadowMap.addressV = pc.gfx.ADDRESS_CLAMP_TO_EDGE;
        return new pc.gfx.RenderTarget(device, shadowMap, true);
    };

    function createShadowCamera(device) {
        // We don't need to clear the color buffer if we're rendering a depth map
        var flags = pc.gfx.CLEARFLAG_DEPTH;
        if (!device.extDepthTexture) flags |= pc.gfx.CLEARFLAG_COLOR;

        var shadowCam = new pc.scene.CameraNode();
        shadowCam.setClearOptions({
            color: [1.0, 1.0, 1.0, 1.0],
            depth: 1.0,
            flags: flags
        });

        return shadowCam;
    };

    function getShadowCamera(device, light) {
        var shadowCam = light._shadowCamera;
        var shadowBuffer;

        if (shadowCam === null) {
            shadowCam = createShadowCamera(device);
            shadowBuffer = createShadowMap(device, light._shadowResolution, light._shadowResolution);
            shadowCam.setRenderTarget(shadowBuffer);
            light._shadowCamera = shadowCam;
        } else {
            shadowBuffer = shadowCam.getRenderTarget();
            if ((shadowBuffer.width !== light._shadowResolution) || (shadowBuffer.height !== light._shadowResolution)) {
                shadowBuffer = createShadowMap(device, light._shadowResolution, light._shadowResolution);
                shadowCam.setRenderTarget(shadowBuffer);
            }
        }

        return shadowCam;
    }

    /**
     * @name pc.scene.ForwardRenderer
     * @class The forward renderer render scene objects.
     * @constructor Creates a new forward renderer object.
     * @param {pc.gfx.Device} graphicsDevice The graphics device used by the renderer.
     */
    function ForwardRenderer(graphicsDevice) {
        this.device = graphicsDevice;

        // Shaders
        var library = this.device.getProgramLibrary();
        this._depthProgStatic = library.getProgram('depthrgba', {
            skin: false,
            opacityMap: false
        });
        this._depthProgSkin = library.getProgram('depthrgba', {
            skin: true,
            opacityMap: false
        });
        this._depthProgStaticOp = library.getProgram('depthrgba', {
            skin: false,
            opacityMap: true
        });
        this._depthProgSkinOp = library.getProgram('depthrgba', {
            skin: true,
            opacityMap: true
        });

        this._depthShaderStatic = library.getProgram('depth', {
            skin: false
        });
        this._depthShaderSkin = library.getProgram('depth', {
            skin: true
        });

        // Uniforms
        var scope = this.device.scope;
        this.projId = scope.resolve('matrix_projection');
        this.viewId = scope.resolve('matrix_view');
        this.viewInvId = scope.resolve('matrix_viewInverse');
        this.viewProjId = scope.resolve('matrix_viewProjection');
        this.viewPosId = scope.resolve('view_position');
        this.nearClipId = scope.resolve('camera_near');
        this.farClipId = scope.resolve('camera_far');

        this.fogColorId = scope.resolve('fog_color');
        this.fogStartId = scope.resolve('fog_start');
        this.fogEndId = scope.resolve('fog_end');
        this.fogDensityId = scope.resolve('fog_density');

        this.modelMatrixId = scope.resolve('matrix_model');
        this.normalMatrixId = scope.resolve('matrix_normal');
        this.poseMatrixId = scope.resolve('matrix_pose[0]');

        this.alphaTestId = scope.resolve('alpha_ref');

        // Shadows
        this._shadowAabb = new pc.shape.Aabb();
        this._sceneAabb = new pc.shape.Aabb();
        this._shadowState = {
            blend: false
        };

        this.fogColor = new Float32Array(0, 0, 0);
    }

    pc.extend(ForwardRenderer.prototype, {
        setCamera: function (camera) {
            // Projection Matrix
            var projMat = camera.getProjectionMatrix();
            this.projId.setValue(projMat.data);

            // ViewInverse Matrix
            var wtm = camera.getWorldTransform();
            this.viewInvId.setValue(wtm.data);

            // View Matrix
            viewMat.copy(wtm).invert();
            this.viewId.setValue(viewMat.data);

            // ViewProjection Matrix
            viewProjMat.mul(projMat, viewMat);
            this.viewProjId.setValue(viewProjMat.data);

            // View Position (world space)
            this.viewPosId.setValue(camera.getPosition().data);

            // Near and far clip values
            this.nearClipId.setValue(camera.getNearClip());
            this.farClipId.setValue(camera.getFarClip());

            camera._frustum.update(projMat, viewMat);

            var device = this.device;
            var target = camera.getRenderTarget();
            device.setRenderTarget(target);
            device.updateBegin();

            var rect = camera.getRect();
            var pixelWidth = target ? target.width : device.width;
            var pixelHeight = target ? target.height : device.height;
            var x = Math.floor(rect.x * pixelWidth);
            var y = Math.floor(rect.y * pixelHeight);
            var w = Math.floor(rect.width * pixelWidth);
            var h = Math.floor(rect.height * pixelHeight);
            device.setViewport(x, y, w, h);
            device.setScissor(x, y, w, h);

            device.clear(camera.getClearOptions());
        },

        dispatchGlobalLights: function (scene) {
            var dirs = scene._globalLights;
            var numDirs = dirs.length;

            var scope = this.device.scope;

            scope.resolve("light_globalAmbient").setValue(scene._globalAmbient);

            for (var i = 0; i < numDirs; i++) {
                var directional = dirs[i];
                var wtm = directional.getWorldTransform();
                light = "light" + i;

                scope.resolve(light + "_color").setValue(directional._finalColor);
                // Directionals shine down the negative Y axis
                directional._direction[0] = -wtm[4];
                directional._direction[1] = -wtm[5];
                directional._direction[2] = -wtm[6];
                scope.resolve(light + "_direction").setValue(directional._direction);

                if (directional.getCastShadows()) {
                    var shadowMap = this.device.extDepthTexture ? 
                            directional._shadowCamera._renderTarget._depthTexture :
                            directional._shadowCamera._renderTarget.colorBuffer;
                    scope.resolve(light + "_shadowMap").setValue(shadowMap);
                    scope.resolve(light + "_shadowMatrix").setValue(directional._shadowMatrix);
                    scope.resolve(light + "_shadowParams").setValue([directional._shadowResolution, directional._shadowResolution, directional._shadowBias]);
                }
            }
        },

        dispatchLocalLights: function (scene) {
            var i, wtm;
            var point, spot;
            var localLights = scene._localLights;

            var pnts = localLights[pc.scene.LIGHTTYPE_POINT-1];
            var spts = localLights[pc.scene.LIGHTTYPE_SPOT-1];

            var numDirs = scene._globalLights.length;
            var numPnts = pnts.length;
            var numSpts = spts.length;

            var scope = this.device.scope;

            for (i = 0; i < numPnts; i++) {
                point = pnts[i];
                wtm = point.getWorldTransform();
                light = "light" + (numDirs + i);

                scope.resolve(light + "_radius").setValue(point._attenuationEnd);
                scope.resolve(light + "_color").setValue(point._finalColor);
                point._position[0] = wtm[12];
                point._position[1] = wtm[13];
                point._position[2] = wtm[14];
                scope.resolve(light + "_position").setValue(point._position);
            }

            for (i = 0; i < numSpts; i++) {
                spot = spts[i];
                wtm = spot.getWorldTransform();
                light = "light" + (numDirs + numPnts + i);

                scope.resolve(light + "_innerConeAngle").setValue(spot._innerConeAngleCos);
                scope.resolve(light + "_outerConeAngle").setValue(spot._outerConeAngleCos);
                scope.resolve(light + "_radius").setValue(spot._attenuationEnd);
                scope.resolve(light + "_color").setValue(spot._finalColor);
                spot._position[0] = wtm[12];
                spot._position[1] = wtm[13];
                spot._position[2] = wtm[14];
                scope.resolve(light + "_position").setValue(spot._position);
                // Spots shine down the negative Y axis
                spot._direction[0] = -wtm[4];
                spot._direction[1] = -wtm[5];
                spot._direction[2] = -wtm[6];
                scope.resolve(light + "_spotDirection").setValue(spot._direction);

                if (spot.getCastShadows()) {
                    var shadowMap = this.device.extDepthTexture ? 
                            spot._shadowCamera._renderTarget._depthTexture :
                            spot._shadowCamera._renderTarget.colorBuffer;
                    scope.resolve(light + "_shadowMap").setValue(shadowMap);
                    scope.resolve(light + "_shadowMatrix").setValue(spot._shadowMatrix);
                    scope.resolve(light + "_shadowParams").setValue([spot._shadowResolution, spot._shadowResolution, spot._shadowBias]);
                }
            }
        },

        /**
         * @function
         * @name pc.scene.ForwardRenderer#render
         * @description Renders the scene using the specified camera.
         * @param {pc.scene.Scene} scene The scene to render.
         * @param {pc.scene.CameraNode} camera The camera with which to render the scene.
         * @author Will Eastcott
         */
        render: function (scene, camera) {
            var device = this.device;
            var scope = device.scope;

            if (scene.updateShaders) {
                scene._updateShaders(device);
                scene.updateShaders = false;
            }

            pc.scene.Scene.current = scene;

            // Fish out all the uniforms we need to render the scene
            var lights = scene._lights;
            var models = scene._models;
            var drawCalls = scene.drawCalls;
            var shadowCasters = scene.shadowCasters;

            var i, j, numInstances;
            var drawCall, meshInstance, prevMeshInstance = null, mesh, material, prevMaterial = null, style;

            // Update all skin matrix palettes
            for (i = 0, numDrawCalls = scene.drawCalls.length; i < numDrawCalls; i++) {
                drawCall = scene.drawCalls[i];
                if (drawCall.skinInstance) {
                    drawCall.skinInstance.updateMatrixPalette();
                }
            }

            scene._globalLights.length = 0;
            scene._localLights[0].length = 0;
            scene._localLights[1].length = 0;

            for (i = 0; i < lights.length; i++) {
                var light = lights[i];
                if (light.getEnabled()) {
                    if (light.getType() === pc.scene.LIGHTTYPE_DIRECTIONAL) {
                        if (light.getCastShadows()) {
                            scene._globalLights.push(light);
                        } else {
                            scene._globalLights.unshift(light);
                        }
                    } else {
                        scene._localLights[light.getType() === pc.scene.LIGHTTYPE_POINT ? 0 : 1].push(light);
                    }
                }
            }

            // Calculate the distance of transparent meshes from the camera
            var camPos = camera.getPosition();
            for (i = 0, numDrawCalls = drawCalls.length; i < numDrawCalls; i++) {
                drawCall = drawCalls[i];
                if (!drawCall.command) {
                    meshInstance = drawCall;

                    if (meshInstance.material.blendType === pc.scene.BLEND_NORMAL) {
                        meshInstance.syncAabb();
                        var meshPos = meshInstance.aabb.center;
                        var tempx = meshPos[0] - camPos[0];
                        var tempy = meshPos[1] - camPos[1];
                        var tempz = meshPos[2] - camPos[2];
                        meshInstance.distSqr = tempx * tempx + tempy * tempy + tempz * tempz;
                    } else if (typeof meshInstance.distSqr !== 'undefined') {
                        delete meshInstance.distSqr;
                    }
                }
            }

            // Sort meshes into the correct render order
            drawCalls.sort(sortDrawCalls);

            if (camera._depthTarget) {
                var oldTarget = camera.getRenderTarget();
                camera.setRenderTarget(camera._depthTarget);

                this.setCamera(camera);

                var oldBlending = device.getBlending();
                device.setBlending(false);

                for (i = 0, numDrawCalls = drawCalls.length; i < numDrawCalls; i++) {
                    drawCall = drawCalls[i];
                    if (!drawCall.command) {
                        meshInstance = drawCall;
                        if (meshInstance.layer !== pc.scene.LAYER_SKYBOX) {
                            mesh = meshInstance.mesh;

                            this.modelMatrixId.setValue(meshInstance.node.worldTransform);
                            if (meshInstance.skinInstance) {
                                this.poseMatrixId.setValue(meshInstance.skinInstance.matrixPaletteF32);
                                device.setShader(this._depthShaderSkin);
                            } else {
                                device.setShader(this._depthShaderStatic);
                            }

                            style = meshInstance.renderStyle;

                            device.setVertexBuffer(mesh.vertexBuffer, 0);
                            device.setIndexBuffer(mesh.indexBuffer[style]);
                            device.draw(mesh.primitive[style]);
                        }
                    }

                    camera.setRenderTarget(oldTarget);
                }
                device.setBlending(oldBlending);
            }

            // Render all shadowmaps
            for (i = 0; i < lights.length; i++) {
                var light = lights[i];
                var type = light.getType();

                // Point light shadow casting currently unsupported
                if (type === pc.scene.LIGHTTYPE_POINT) {
                    continue;
                }

                if (light.getCastShadows() && light.getEnabled()) {
                    var shadowCam = getShadowCamera(device, light);

                    if (type === pc.scene.LIGHTTYPE_DIRECTIONAL) {
                        // 1. Starting at the centroid of the view frustum, back up in the opposite
                        // direction of the light by a certain amount. This will be our temporary 
                        // working position.
                        var centroid = camera.getFrustumCentroid();
                        shadowCam.setPosition(centroid);
                        var lightDir = new pc.Vector3();
                        light.worldTransform.getY(lightDir);
                        shadowCam.translate(lightDir);

                        // 2. Come up with a LookAt matrix using the light direction, and the 
                        // temporary working position. This will be the view matrix that is used
                        // when generating the shadow map.
                        shadowCam.lookAt(centroid);
                        shadowCamWtm.copy(shadowCam.getWorldTransform());

                        // 3. Transform the 8 corners of the frustum by the LookAt Matrix
                        _getFrustumPoints(camera, frustumPoints);
                        var worldToShadowCam = shadowCamWtm.invert();
                        var camToWorld = camera.worldTransform;
                        var c2sc = new pc.Matrix();
                        c2sc.mul(worldToShadowCam, camToWorld);
                        for (j = 0; j < 8; j++) {
                            c2sc.transformPoint(frustumPoints[j], frustumPoints[j]);
                        }

                        // 4. Come up with a bounding box (in light-space) by calculating the min
                        // and max X, Y, and Z values from your 8 light-space frustum coordinates.
                        var minx = 1000000;
                        var maxx = -1000000;
                        var miny = 1000000;
                        var maxy = -1000000;
                        var minz = 1000000;
                        var maxz = -1000000;
                        for (j = 0; j < 8; j++) {
                            var p = frustumPoints[j];
                            if (p[0] < minx) minx = p.x;
                            if (p[0] > maxx) maxx = p.x;
                            if (p[1] < miny) miny = p.y;
                            if (p[1] > maxy) maxy = p.y;
                            if (p[2] < minz) minz = p.z;
                            if (p[2] > maxz) maxz = p.z;
                        }
    /*
                        var worldUnitsPerTexelX = (maxx - minx) / light._shadowWidth;
                        var worldUnitsPerTexelY = (maxy - miny) / light._shadowHeight;

                        minx /= worldUnitsPerTexelX;
                        minx = Math.floor(minx);
                        minx *= worldUnitsPerTexelX;
                        maxx /= worldUnitsPerTexelX;
                        maxx = Math.floor(maxx);
                        maxx *= worldUnitsPerTexelX;

                        miny /= worldUnitsPerTexelY;
                        miny = Math.floor(miny);
                        miny *= worldUnitsPerTexelY;
                        maxy /= worldUnitsPerTexelY;
                        maxy = Math.floor(maxy);
                        maxy *= worldUnitsPerTexelY;
    */
                        // 5. Use your min and max values to create an off-center orthographic projection.
                        shadowCam.translateLocal(-(maxx + minx) * 0.5, (maxy + miny) * 0.5, maxz + (maxz - minz) * 0.25);
                        shadowCamWtm.copy(shadowCam.getWorldTransform());

                        shadowCam.setProjection(pc.scene.Projection.ORTHOGRAPHIC);
                        shadowCam.setNearClip(0);
                        shadowCam.setFarClip((maxz - minz) * 1.5);
                        shadowCam.setAspectRatio((maxx - minx) / (maxy - miny));
                        shadowCam.setOrthoHeight((maxy - miny) * 0.5);
                    } else if (type === pc.scene.LIGHTTYPE_SPOT) {
                        shadowCam.setProjection(pc.scene.Projection.PERSPECTIVE);
                        shadowCam.setNearClip(light.getAttenuationEnd() / 1000);
                        shadowCam.setFarClip(light.getAttenuationEnd());
                        shadowCam.setAspectRatio(1);
                        shadowCam.setFov(light.getOuterConeAngle() * 2);

                        var lightWtm = light.worldTransform;
                        shadowCamWtm.mul(lightWtm, camToLight);
                    }

                    shadowCamView.copy(shadowCamWtm).invert();
                    shadowCamViewProj.mul(shadowCam.getProjectionMatrix(), shadowCamView);
                    light._shadowMatrix.mul(scaleShift, shadowCamViewProj);

                    // Point the camera along direction of light
                    shadowCam.worldTransform.copy(shadowCamWtm);

                    this.setCamera(shadowCam);

                    device.setBlending(false);
                    device.setColorWrite(true, true, true, true);
                    device.setCullMode(pc.gfx.CULLFACE_BACK);
                    device.setDepthWrite(true);
                    device.setDepthTest(true);

                    if (device.extDepthTexture) {
                        device.setColorWrite(false, false, false, false);
                    }

                    for (j = 0, numInstances = shadowCasters.length; j < numInstances; j++) {
                        meshInstance = shadowCasters[j];
                        mesh = meshInstance.mesh;
                        material = meshInstance.material;

                        this.modelMatrixId.setValue(meshInstance.node.worldTransform);
                        if (material.opacityMap) {
                            scope.resolve('texture_opacityMap').setValue(material.opacityMap);
                        }
                        if (meshInstance.skinInstance) {
                            this.poseMatrixId.setValue(meshInstance.skinInstance.matrixPaletteF32);
                            device.setShader(material.opacityMap ? this._depthProgSkinOp : this._depthProgSkin);
                        } else {
                            device.setShader(material.opacityMap ? this._depthProgStaticOp : this._depthProgStatic);
                        }

                        style = meshInstance.renderStyle;

                        device.setVertexBuffer(mesh.vertexBuffer, 0);
                        device.setIndexBuffer(mesh.indexBuffer[style]);

                        device.draw(mesh.primitive[style]);
                    }
                }
            }

            // Set up the camera
            this.setCamera(camera);

            // Set up the lights
            this.dispatchGlobalLights(scene);
            this.dispatchLocalLights(scene);

            // Set up the fog
            if (scene.fog !== pc.scene.FOG_NONE) {
                this.fogColor[0] = scene.fogColor.r;
                this.fogColor[1] = scene.fogColor.g;
                this.fogColor[2] = scene.fogColor.b;
                this.fogColorId.setValue(this.fogColor);
                if (scene.fog === pc.scene.FOG_LINEAR) {
                    this.fogStartId.setValue(scene.fogStart);
                    this.fogEndId.setValue(scene.fogEnd);
                } else {
                    this.fogDensityId.setValue(scene.fogDensity);
                }
            }

            for (i = 0, numDrawCalls = drawCalls.length; i < numDrawCalls; i++) {
                drawCall = drawCalls[i];
                if (drawCall.command) {
                    // We have a command
                    drawCall.command();
                } else {
                    // We have a mesh instance
                    meshInstance = drawCall;
                    mesh = meshInstance.mesh;
                    material = meshInstance.material;

                    var modelMatrix = meshInstance.node.worldTransform;
                    var normalMatrix = meshInstance.normalMatrix;

                    modelMatrix.invertTo3x3(normalMatrix);
                    normalMatrix.transpose();

                    this.modelMatrixId.setValue(modelMatrix);
                    this.normalMatrixId.setValue(normalMatrix);
                    if (meshInstance.skinInstance) {
                        this.poseMatrixId.setValue(meshInstance.skinInstance.matrixPaletteF32);
                    }

                    if (material !== prevMaterial) {
                        if (!material.shader) {
                            material.updateShader(device, scene);
                        }
                        device.setShader(material.shader);

                        var parameters = material.parameters;
                        for (var paramName in parameters) {
                            var parameter = parameters[paramName];
                            if (!parameter.scopeId) {
                                parameter.scopeId = device.scope.resolve(paramName);
                            }
                            parameter.scopeId.setValue(parameter.data);
                        }

                        this.alphaTestId.setValue(material.alphaTest);

                        device.setBlending(material.blend);
                        device.setBlendFunction(material.blendSrc, material.blendDst);
                        device.setBlendEquation(material.blendEquation);
                        device.setColorWrite(material.redWrite, material.greenWrite, material.blueWrite, material.alphaWrite);
                        device.setCullMode(material.cull);
                        device.setDepthWrite(material.depthWrite);
                        device.setDepthTest(material.depthTest);
                    }

                    device.setVertexBuffer(mesh.vertexBuffer, 0);
                    style = meshInstance.renderStyle;
                    device.setIndexBuffer(mesh.indexBuffer[style]);
                    device.draw(mesh.primitive[style]);

                    prevMaterial = material;
                    prevMeshInstance = meshInstance;
                }
            }
        }
    });

    return {
        ForwardRenderer: ForwardRenderer
    }; 
}());