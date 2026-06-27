/* Player Vision Plus for Foundry VTT */
(() => {
  "use strict";

  const MODULE_ID = "player-vision-plus";
  const REQUIRED_OWNERSHIP = 3;

  class PlayerVisionPlusDetectionFilter extends foundry.canvas.rendering.filters.AbstractBaseFilter {
    static _createVertexShader() {
      return `\
        attribute vec2 aVertexPosition;

        uniform vec4 inputSize;
        uniform vec4 outputFrame;
        uniform mat3 projectionMatrix;
        uniform vec2 origin;
        uniform mediump float thickness;

        varying vec2 vTextureCoord;
        varying float vOffset;

        void main() {
            vTextureCoord = (aVertexPosition * outputFrame.zw) * inputSize.zw;
            vec2 position = aVertexPosition * max(outputFrame.zw, vec2(0.0)) + outputFrame.xy;
            vec2 offset = position - origin;
            vOffset = (offset.x + offset.y) / (1.414213562373095 * 2.0 * thickness);
            gl_Position = vec4((projectionMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);
        }
    `;
    }

    static _createFragmentShader() {
      return `\
        varying vec2 vTextureCoord;
        varying float vOffset;

        uniform sampler2D uSampler;
        uniform mediump float thickness;

        void main() {
            float x = abs(vOffset - floor(vOffset + 0.5)) * 2.0;
            float y0 = clamp((x + 0.5) * thickness + 0.5, 0.0, 1.0);
            float y1 = clamp((x - 0.5) * thickness + 0.5, 0.0, 1.0);
            float y = y0 - y1;
            float alpha = texture2D(uSampler, vTextureCoord).a * 0.25;
            gl_FragColor = vec4(y, y, y, 1.0) * alpha;
        }
    `;
    }

    static defaultUniforms = {
      origin: { x: 0.0, y: 0.0 },
      thickness: 1.0,
    };

    apply(filterManager, input, output, clearMode, currentState) {
      const uniforms = this.uniforms;
      const worldTransform = currentState.target.worldTransform;

      uniforms.origin.x = worldTransform.tx;
      uniforms.origin.y = worldTransform.ty;
      uniforms.thickness = 4 * canvas.dimensions.uiScale * canvas.stage.scale.x;

      super.apply(filterManager, input, output, clearMode, currentState);
    }
  }

  let tokenHatch;
  let detectionFilter;
  let patched = false;
  let tokenVisibilityPatched = false;
  const secondaryDetectedTokenIds = new Set();
  let refreshQueued = false;
  const tokenPositionCache = new Map();

  function setting(key) {
    return game.settings.get(MODULE_ID, key);
  }

  function isEnabledForThisClient() {
    // World setting is the GM-controlled maximum. The user's client setting is
    // their personal opt-in. Player Vision Plus is active only when both are on.
    try {
      return Boolean(game.settings.get(MODULE_ID, "worldEnabled"))
        && Boolean(game.settings.get(MODULE_ID, "enabled"));
    } catch (_) {
      return false;
    }
  }

  function renderMode() {
    return "tokenOnly";
  }

  function isTokenOnlyMode() {
    return true;
  }

  function debug(...args) {
    try {
      if (game.settings.get(MODULE_ID, "debug")) console.debug(`${MODULE_ID} |`, ...args);
    } catch (_) {}
  }

  function isNoCanvas() {
    return game.settings.get("core", "noCanvas");
  }

  const ApplicationV2 = foundry.applications?.api?.ApplicationV2;
  const HandlebarsApplicationMixin = foundry.applications?.api?.HandlebarsApplicationMixin;

  class PlayerVisionPlusPlayerSettingsApp extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
      id: "player-vision-plus-player-settings",
      tag: "form",
      classes: ["player-vision-plus-settings"],
      window: {
        title: "PVPLUS.menu.playerSettings.title"
      },
      position: {
        width: 420
      },
      form: {
        handler: PlayerVisionPlusPlayerSettingsApp.#onSubmit,
        submitOnChange: false,
        closeOnSubmit: true
      }
    };

    static PARTS = {
      body: {
        template: `modules/${MODULE_ID}/templates/player-settings.hbs`
      }
    };

    async _prepareContext(options) {
      const worldEnabled = Boolean(game.settings.get(MODULE_ID, "worldEnabled"));
      const userEnabled = Boolean(game.settings.get(MODULE_ID, "enabled"));
      const effectiveEnabled = worldEnabled && userEnabled;
      const sharePartyVision = Boolean(game.settings.get(MODULE_ID, "sharePartyVision"));
      const statusKey = !effectiveEnabled
        ? "inactive"
        : sharePartyVision
          ? "alsoAlliedOwned"
          : "ownedCharactersOnly";

      return {
        ...(await super._prepareContext(options)),
        enabled: userEnabled,
        worldEnabled,
        effectiveEnabled,
        sharePartyVision,
        statusKey,
        statusInactive: statusKey === "inactive",
        statusOwnedOnly: statusKey === "ownedCharactersOnly",
        statusAlliedOwned: statusKey === "alsoAlliedOwned"
      };
    }

    static async #onSubmit(event, form, formData) {
      await game.settings.set(MODULE_ID, "enabled", Boolean(formData.object.enabled));
      refreshCanvasVision();
    }
  }

  function registerSettings() {
    game.settings.register(MODULE_ID, "worldEnabled", {
      name: "PVPLUS.settings.worldEnabled.name",
      hint: "PVPLUS.settings.worldEnabled.hint",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      restricted: true,
      onChange: refreshCanvasVision
    });

    game.settings.register(MODULE_ID, "enabled", {
      name: "PVPLUS.settings.enabled.name",
      hint: "PVPLUS.settings.enabled.hint",
      scope: "client",
      // Personal opt-in is hidden from Foundry's standard settings list. Players
      // get a dedicated menu below; GMs only see the world-level cap.
      config: false,
      type: Boolean,
      default: true,
      onChange: refreshCanvasVision
    });

    if (!game.user?.isGM) {
      game.settings.registerMenu(MODULE_ID, "playerSettings", {
        name: "PVPLUS.menu.playerSettings.name",
        label: "PVPLUS.menu.playerSettings.label",
        hint: "PVPLUS.menu.playerSettings.hint",
        icon: "fas fa-eye",
        type: PlayerVisionPlusPlayerSettingsApp,
        restricted: false
      });
    }

    game.settings.register(MODULE_ID, "sharePartyVision", {
      name: "PVPLUS.settings.sharePartyVision.name",
      hint: "PVPLUS.settings.sharePartyVision.hint",
      scope: "world",
      config: true,
      type: Boolean,
      default: false,
      restricted: true,
      onChange: refreshCanvasVision
    });

    game.settings.register(MODULE_ID, "debug", {
      name: "PVPLUS.settings.debug.name",
      hint: "PVPLUS.settings.debug.hint",
      scope: "client",
      config: true,
      type: Boolean,
      default: false,
      onChange: refreshCanvasVision
    });
  }

  function scheduleSecondaryVisionRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    const raf = globalThis.requestAnimationFrame ?? ((fn) => window.setTimeout(fn, 16));
    raf(() => {
      refreshQueued = false;
      refreshSecondaryVision();
    });
  }

  function tokenPositionSignature(token) {
    if (!token) return "";
    const doc = token.document ?? {};
    const center = token.center ?? {};
    return [
      token.id,
      Math.round(Number(doc.x ?? token.x ?? center.x ?? 0) * 100) / 100,
      Math.round(Number(doc.y ?? token.y ?? center.y ?? 0) * 100) / 100,
      Math.round(Number(token.x ?? doc.x ?? center.x ?? 0) * 100) / 100,
      Math.round(Number(token.y ?? doc.y ?? center.y ?? 0) * 100) / 100,
      Math.round(Number(center.x ?? 0) * 100) / 100,
      Math.round(Number(center.y ?? 0) * 100) / 100
    ].join("|");
  }

  function watchTokenMovementFrame() {
    if (!canvas?.ready || game.user?.isGM || isNoCanvas()) return;
    let changed = false;
    for (const token of canvas.tokens?.placeables ?? []) {
      const signature = tokenPositionSignature(token);
      if (tokenPositionCache.get(token.id) !== signature) {
        tokenPositionCache.set(token.id, signature);
        changed = true;
      }
    }
    for (const id of Array.from(tokenPositionCache.keys())) {
      if (!(canvas.tokens?.placeables ?? []).some((t) => t.id === id)) {
        tokenPositionCache.delete(id);
        changed = true;
      }
    }
    if (changed && isTokenOnlyMode()) scheduleSecondaryVisionRefresh();
  }

  function refreshCanvasVision() {
    if (!canvas?.ready || isNoCanvas()) return;
    canvas.perception?.update?.({ refreshVision: true, refreshLighting: true, refreshSounds: false }, true);
    window.setTimeout(scheduleSecondaryVisionRefresh, 0);
  }

  function getOwnershipLevel(actor, userId) {
    const ownership = actor?.ownership ?? actor?.data?.ownership ?? {};
    return ownership[userId] ?? ownership.default ?? 0;
  }

  function isOwnedByCurrentUser(token) {
    return token?.isOwner || getOwnershipLevel(token?.actor, game.user.id) >= REQUIRED_OWNERSHIP;
  }

  function isOwnedByAnyPlayer(token) {
    const actor = token?.actor;
    if (!actor) return false;
    for (const user of game.users ?? []) {
      if (user.isGM) continue;
      if (getOwnershipLevel(actor, user.id) >= REQUIRED_OWNERSHIP) return true;
    }
    return false;
  }

  function isOwnedByAnotherPlayer(token) {
    const actor = token?.actor;
    if (!actor) return false;
    for (const user of game.users ?? []) {
      if (user.isGM || user.id === game.user.id) continue;
      if (getOwnershipLevel(actor, user.id) >= REQUIRED_OWNERSHIP) return true;
    }
    return false;
  }

  function hasSight(token) {
    return Boolean(token?.document?.sight?.enabled || token?.hasSight);
  }

  function isSecondaryTokenForCurrentView(token) {
    if (!canvas?.ready || game.user.isGM || isNoCanvas()) return false;
    if (!isEnabledForThisClient()) return false;
    if (!canvas.visibility?.tokenVision) return false;
    if (!token?.document || token.destroyed || token.document.hidden) return false;
    if (!hasSight(token)) return false;
    if (token.controlled) return false;

    const hasControlledToken = (canvas.tokens?.controlled?.length ?? 0) > 0;

    // Own additional tokens are only shown while the player is focusing one selected token.
    if (isOwnedByCurrentUser(token)) return hasControlledToken;

    // Shared party vision is different: tokens owned only by other players should always
    // contribute dimmed secondary vision, even when the current player has no token selected.
    if (setting("sharePartyVision") && isOwnedByAnotherPlayer(token)) return true;

    return false;
  }

  function shouldForceSecondaryVisionSource(token) {
    // In token-only mode the module must not add secondary tokens as real Foundry
    // vision sources. Otherwise Foundry draws the dark/bright vision-radius artefacts
    // the user reported. Token-only mode only uses secondary vision for token detection.
    if (isTokenOnlyMode()) return false;
    return isSecondaryTokenForCurrentView(token);
  }

  function getDetectionFilter() {
    return detectionFilter ??= PlayerVisionPlusDetectionFilter.create();
  }

  function tokenNeedsSecondaryDetectionFilter(token) {
    if (!canvas?.ready || game.user.isGM || isNoCanvas()) return false;
    if (!isEnabledForThisClient()) return false;
    if (!canvas.visibility?.tokenVision) return false;
    if (!token?.document || token.destroyed || token.document.hidden) return false;
    if (token.controlled) return false;

    // In token-only mode, use the explicit target cache built during sight refresh.
    // This avoids repeatedly creating secondary vision sources from inside Token#isVisible,
    // which can cause Foundry to draw dark secondary vision circles.
    if (isTokenOnlyMode()) return secondaryDetectedTokenIds.has(token.id);

    const secondaryEntries = getSecondaryVisionEntries();
    if (!secondaryEntries.length) return false;
    const primaryShapes = getControlledVisionShapes();
    return isTokenOnlyInSecondaryVision(token, secondaryEntries, primaryShapes);
  }

  function patchTokenVisibilityFilter() {
    if (tokenVisibilityPatched) return;
    const TokenClass = foundry?.canvas?.placeables?.Token ?? CONFIG?.Token?.objectClass;
    const descriptor = TokenClass && Object.getOwnPropertyDescriptor(TokenClass.prototype, "isVisible");
    if (!TokenClass || typeof descriptor?.get !== "function") {
      console.warn(`${MODULE_ID} | Could not patch Token#isVisible; Foundry Token class not found.`);
      return;
    }

    const originalGetter = descriptor.get;
    Object.defineProperty(TokenClass.prototype, "isVisible", {
      configurable: true,
      get: function playerVisionPlusIsVisible() {
        const visible = originalGetter.call(this);
        const secondaryDetected = tokenNeedsSecondaryDetectionFilter(this);

        if (secondaryDetected) {
          this.detectionFilter = getDetectionFilter();
          this._playerVisionPlusDetectionFilter = true;
          return true;
        }

        if (this._playerVisionPlusDetectionFilter) {
          this._playerVisionPlusDetectionFilter = false;
          if (this.detectionFilter === detectionFilter) this.detectionFilter = undefined;
        }

        return visible;
      }
    });

    tokenVisibilityPatched = true;
    console.log(`${MODULE_ID} | Patched Token#isVisible for GM-Vision-style secondary detection filter.`);
  }

  function patchVisionSourceEligibility() {
    if (patched) return;

    const TokenClass = foundry?.canvas?.placeables?.Token ?? CONFIG?.Token?.objectClass;
    if (!TokenClass?.prototype?._isVisionSource) {
      console.warn(`${MODULE_ID} | Could not patch Token#_isVisionSource; Foundry Token class not found.`);
      return;
    }

    const original = TokenClass.prototype._isVisionSource;
    TokenClass.prototype._isVisionSource = function playerVisionPlusIsVisionSource(...args) {
      const normal = original.apply(this, args);
      if (normal) return true;
      const extra = shouldForceSecondaryVisionSource(this);
      if (extra) debug("forcing extra vision source", this.name, this.id);
      return extra;
    };

    patched = true;
    console.log(`${MODULE_ID} | Patched Token#_isVisionSource for secondary player vision.`);
  }

  function tryInitializeTemporaryVisionSource(token) {
    // Best-effort feature-detected fallback for token-only mode. Different Foundry
    // versions expose different internals, so try safe methods without throwing.
    try {
      if (typeof token.initializeVisionSource === "function") {
        token.initializeVisionSource();
        return token.vision ?? canvas.effects?.visionSources?.get?.(token.sourceId) ?? canvas.effects?.visionSources?.get?.(token.id);
      }
    } catch (err) {
      debug("initializeVisionSource failed", token?.name, err);
    }

    try {
      if (typeof token._initializeVisionSource === "function") {
        token._initializeVisionSource();
        return token.vision ?? canvas.effects?.visionSources?.get?.(token.sourceId) ?? canvas.effects?.visionSources?.get?.(token.id);
      }
    } catch (err) {
      debug("_initializeVisionSource failed", token?.name, err);
    }

    return null;
  }



  function gridDistanceUnits() {
    return Number(canvas.scene?.grid?.distance ?? canvas.dimensions?.distance ?? 5) || 5;
  }

  function gridSizePixels() {
    return Number(canvas.dimensions?.size ?? canvas.grid?.size ?? 100) || 100;
  }

  function distanceUnitsToPixels(units) {
    const n = Number(units);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return (n / gridDistanceUnits()) * gridSizePixels();
  }

  function maybeSceneDistanceToPixels(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;

    // Foundry document data normally stores sight/light ranges in scene distance
    // units, while some live source data already stores pixels. Treat very large
    // values as pixels; small tabletop values are converted from scene units.
    const size = gridSizePixels();
    return n > size * 2 ? n : distanceUnitsToPixels(n);
  }

  function sceneDiagonalPixels() {
    const rect = canvas.dimensions?.rect;
    if (rect?.width && rect?.height) return Math.hypot(rect.width, rect.height);
    return Number(canvas.dimensions?.maxR) || 10_000;
  }

  function sightRadiusPixels(token) {
    const sight = token?.document?.sight ?? {};

    // Prefer the token document range because it is the GM/player configured sight
    // range in scene units. The previous implementation preferred token.sightRange;
    // in Foundry v14 that can be a scene-sized backend cap, causing 1-unit vision
    // to become ~15000px and revealing enemies far outside real vision range.
    const documentRange = Number(sight.range);
    if (Number.isFinite(documentRange) && documentRange > 0) return distanceUnitsToPixels(documentRange);

    const liveCandidates = [
      token?.vision?.data?.radius,
      token?.sightRange,
      sight.dim,
      sight.bright
    ];

    const live = liveCandidates.map(Number).find((n) => Number.isFinite(n) && n > 0);
    if (live) return maybeSceneDistanceToPixels(live);

    // 0/undefined sight can mean unlimited sight bounded by walls/scene. Use a
    // finite cap for backend LOS polygons, but only when no explicit range exists.
    return sceneDiagonalPixels();
  }

  function makeBackendSightPolygon(token, radiusOverride = null) {
    try {
      const origin = tokenCenter(token);
      const override = Number(radiusOverride);
      const radius = Number.isFinite(override) && override > 0 ? override : sightRadiusPixels(token);
      const sight = token?.document?.sight ?? {};
      const angle = Number(sight.angle ?? 360) || 360;
      const rotation = Number(token?.document?.rotation ?? token?.rotation ?? 0) || 0;
      const config = {
        type: "sight",
        source: token,
        radius,
        angle,
        rotation,
        useThreshold: true,
        edgeDirectionMode: CONST?.EDGE_DIRECTIONS?.BOTH ?? CONST?.WALL_DIRECTIONS?.BOTH ?? 0
      };

      const backend = CONFIG?.Canvas?.polygonBackends?.sight;
      if (backend?.create) return backend.create(origin, config);

      const PolygonClass = foundry?.canvas?.geometry?.ClockwiseSweepPolygon ?? globalThis.ClockwiseSweepPolygon;
      if (PolygonClass?.create) return PolygonClass.create(origin, config);
    } catch (err) {
      debug("backend sight polygon failed", token?.name, err);
    }
    return null;
  }

  function makeBackendLosPolygon(token) {
    // Token-only mode needs two different geometries:
    // 1) normal vision range for darkness / special senses
    // 2) wall-bounded LOS out to the scene edge so an illuminated target outside
    //    darkvision range can still be known, matching normal Foundry/D&D behavior.
    return makeBackendSightPolygon(token, sceneDiagonalPixels());
  }

  function makeFallbackVisionCircle(token) {
    const radius = sightRadiusPixels(token);
    if (!Number.isFinite(radius) || radius <= 0) return null;

    const { x, y } = tokenCenter(token);
    const points = [];
    const steps = 64;
    for (let i = 0; i < steps; i++) {
      const a = (Math.PI * 2 * i) / steps;
      points.push(x + Math.cos(a) * radius, y + Math.sin(a) * radius);
    }
    return { points, contains: (px, py) => ((px - x) ** 2 + (py - y) ** 2) <= radius ** 2 };
  }

  function getTokenVisionShape(token) {
    let src = token?.vision ?? canvas.effects?.visionSources?.get?.(token?.sourceId) ?? canvas.effects?.visionSources?.get?.(token?.id);

    // In token-only mode we still need geometry to decide which tokens are known by
    // secondary vision, but we should not rely on making those tokens real active
    // Foundry vision sources. Try existing/temporary geometry first, then fall back to
    // a range circle so tokens are at least shown without adding map/Fog artefacts.
    if (!src && isTokenOnlyMode()) src = tryInitializeTemporaryVisionSource(token);
    return src?.fov ?? src?.los ?? src?.shape ?? (isTokenOnlyMode() ? (makeBackendSightPolygon(token) ?? makeFallbackVisionCircle(token)) : null);
  }

  function getControlledVisionShapes() {
    return (canvas.tokens?.controlled ?? [])
      .map(getTokenVisionShape)
      .filter(Boolean);
  }

  function getSecondaryVisionEntries() {
    return (canvas.tokens?.placeables ?? [])
      .filter(isSecondaryTokenForCurrentView)
      .map((token) => ({
        token,
        shape: getTokenVisionShape(token),
        losShape: isTokenOnlyMode() ? (makeBackendLosPolygon(token) ?? getTokenVisionShape(token)) : getTokenVisionShape(token)
      }))
      .filter((entry) => Boolean(entry.shape || entry.losShape));
  }

  function drawShape(graphics, shape) {
    if (!shape) return;
    const points = shape.points;
    if (Array.isArray(points) && points.length >= 4) {
      graphics.moveTo(points[0], points[1]);
      for (let i = 2; i < points.length; i += 2) graphics.lineTo(points[i], points[i + 1]);
      graphics.closePath();
      return;
    }
    try {
      graphics.drawShape(shape);
    } catch (err) {
      debug("could not draw shape", shape, err);
    }
  }

  function clearGraphics(graphics) {
    if (!graphics) return;
    graphics.clear();
    graphics.visible = false;
  }


  function ensureTokenHatch() {
    if (tokenHatch && !tokenHatch.destroyed) return tokenHatch;

    const GraphicsClass = PIXI.LegacyGraphics ?? PIXI.Graphics;
    tokenHatch = new GraphicsClass();
    tokenHatch.name = `${MODULE_ID}.tokenHatch`;
    tokenHatch.visible = false;
    tokenHatch.eventMode = "none";
    tokenHatch.interactive = false;
    tokenHatch.zIndex = 10_001;

    const parent = canvas.interface ?? canvas.controls ?? canvas.stage;
    parent.sortableChildren = true;
    parent.addChild(tokenHatch);
    debug("created token hatch overlay", { parent: parent.name, zIndex: tokenHatch.zIndex });
    return tokenHatch;
  }

  function pointInShape(shape, x, y) {
    const points = shape?.points;
    if (!Array.isArray(points) || points.length < 6) {
      try {
        return Boolean(shape?.contains?.(x, y));
      } catch (_) {
        return false;
      }
    }

    let inside = false;
    for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
      const xi = points[i];
      const yi = points[i + 1];
      const xj = points[j];
      const yj = points[j + 1];
      const intersects = ((yi > y) !== (yj > y)) &&
        (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function tokenCenter(token) {
    return {
      x: token.center?.x ?? token.x + (token.w ?? token.width ?? canvas.grid.size) / 2,
      y: token.center?.y ?? token.y + (token.h ?? token.height ?? canvas.grid.size) / 2
    };
  }

  function tokenSceneRect(token) {
    const x = token.document?.x ?? token.x ?? 0;
    const y = token.document?.y ?? token.y ?? 0;
    const width = token.w ?? token.width ?? ((token.document?.width ?? 1) * canvas.grid.size);
    const height = token.h ?? token.height ?? ((token.document?.height ?? 1) * canvas.grid.size);
    return { x, y, width, height };
  }

  function tokenVisibilityPoints(token) {
    const center = tokenCenter(token);
    const rect = tokenSceneRect(token);
    const inset = Math.max(1, Math.min(rect.width, rect.height) * 0.25);
    return [
      center,
      { x: rect.x + inset, y: rect.y + inset },
      { x: rect.x + rect.width - inset, y: rect.y + inset },
      { x: rect.x + inset, y: rect.y + rect.height - inset },
      { x: rect.x + rect.width - inset, y: rect.y + rect.height - inset }
    ];
  }

  function tokenIlluminationPoints(token) {
    // Match Foundry's conservative token visibility behavior more closely: for
    // hostile token discovery, light must reach the token center. Sampling token
    // edges or inner probes can reveal tokens that slightly clip a wall, or that
    // stand directly against diagonal walls where a probe falls on the lit side.
    return [tokenCenter(token)];
  }

  function getTokenVisionSource(token) {
    return token?.vision
      ?? canvas.effects?.visionSources?.get?.(token?.sourceId)
      ?? canvas.effects?.visionSources?.get?.(token?.id)
      ?? (isTokenOnlyMode() ? tryInitializeTemporaryVisionSource(token) : null);
  }

  function testVisibilityWithTemporarySource(sourceToken, targetToken) {
    const source = getTokenVisionSource(sourceToken);
    const sources = canvas.effects?.visionSources;
    if (!source || !sources || !canvas.visibility?.testVisibility) return undefined;

    const key = source.sourceId ?? sourceToken.sourceId ?? sourceToken.id;
    const savedSources = new Map(sources);
    const points = tokenVisibilityPoints(targetToken);
    const options = {
      object: targetToken,
      tolerance: Math.max(1, Math.round((canvas.dimensions?.size ?? 100) * 0.04))
    };

    try {
      // IMPORTANT: isolate the test to exactly this one secondary source.
      // The previous implementation only added the secondary source to Foundry's
      // active sources. canvas.visibility.testVisibility then also considered the
      // currently selected token's normal vision source, which could make targets
      // appear even when the secondary ally itself could not see them.
      sources.clear();
      sources.set(key, source);

      // Prefer a source-local test when available; otherwise use the VisibilityLayer
      // while the active source collection is isolated to this one source. Both paths
      // keep Foundry's own darkness / illumination / detection-mode rules involved.
      if (typeof source.testVisibility === "function") return Boolean(source.testVisibility(points, options));
      if (typeof source._testVisibility === "function") return Boolean(source._testVisibility(points, options));
      return Boolean(canvas.visibility.testVisibility(points, options));
    } catch (err) {
      debug("isolated secondary visibility test failed", sourceToken?.name, targetToken?.name, err);
      return undefined;
    } finally {
      try {
        sources.clear();
        for (const [savedKey, savedSource] of savedSources) sources.set(savedKey, savedSource);
      } catch (_) {}
    }
  }

  function isBasicOrNoVisionMode(sourceToken) {
    const mode = sourceToken?.document?.sight?.visionMode
      ?? sourceToken?.vision?.data?.visionMode
      ?? sourceToken?.vision?.visionMode?.id
      ?? sourceToken?.vision?.visionMode;
    if (!mode) return true;
    const id = String(mode?.id ?? mode).toLowerCase();
    return !id || id === "basic" || id === "none";
  }

  function getDnd5eSenseRange(sourceToken, key) {
    const sensesPath = "system.attributes.senses";
    const rangesPath = `${sensesPath}.ranges.${key}`;

    // DnD5e 5.3+ stores sense distances under senses.ranges.*.
    // Do not read senses.darkvision / senses.blindsight directly when ranges exists,
    // because those are compatibility getters which spam deprecation warnings.
    const candidates = [
      sourceToken?.document?.sight?.[key],
      foundry.utils.getProperty(sourceToken?.actor, rangesPath)
    ];

    const ranges = foundry.utils.getProperty(sourceToken?.actor, `${sensesPath}.ranges`);
    if (!ranges) candidates.push(foundry.utils.getProperty(sourceToken?.actor, `${sensesPath}.${key}`));

    for (const value of candidates) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  }

  function specialVisionDetails(sourceToken, targetToken = null) {
    const mode = sourceToken?.document?.sight?.visionMode
      ?? sourceToken?.vision?.data?.visionMode
      ?? sourceToken?.vision?.visionMode?.id
      ?? sourceToken?.vision?.visionMode;
    const id = String(mode?.id ?? mode ?? "").toLowerCase();
    const modeIsSpecial = Boolean(id && id !== "basic" && id !== "none");
    const distance = targetToken ? measureDistanceBetweenTokens(sourceToken, targetToken) : null;
    const ranges = {
      darkvision: getDnd5eSenseRange(sourceToken, "darkvision"),
      tremorsense: getDnd5eSenseRange(sourceToken, "tremorsense"),
      blindsight: getDnd5eSenseRange(sourceToken, "blindsight"),
      truesight: getDnd5eSenseRange(sourceToken, "truesight"),
      devilsSight: getDnd5eSenseRange(sourceToken, "devilsSight")
    };
    const activeRanges = Object.entries(ranges).filter(([, range]) => range > 0);
    const inAnySenseRange = targetToken
      ? activeRanges.some(([, range]) => Number(distance) <= range)
      : activeRanges.length > 0;
    return { id, modeIsSpecial, distance, ranges, activeRanges: Object.fromEntries(activeRanges), inAnySenseRange, hasAny: modeIsSpecial || activeRanges.length > 0 };
  }

  function tokenHasSpecialDarknessVision(sourceToken, targetToken = null) {
    const details = specialVisionDetails(sourceToken, targetToken);
    if (targetToken) return details.modeIsSpecial || details.inAnySenseRange;
    return details.hasAny;
  }

  function tokenDisposition(token) {
    return Number(token?.document?.disposition ?? token?.document?.data?.disposition ?? 0) || 0;
  }

  function isPlayerOwnedNonHostile(token) {
    return isOwnedByAnyPlayer(token) && tokenDisposition(token) >= 0;
  }

  function measureDistanceBetweenTokens(a, b) {
    try {
      return canvas.grid.measurePath([tokenCenter(a), tokenCenter(b)]).distance;
    } catch (_) {
      const ac = tokenCenter(a);
      const bc = tokenCenter(b);
      return Math.hypot(ac.x - bc.x, ac.y - bc.y) / Math.max(1, gridSizePixels()) * sceneGridDistance();
    }
  }

  function shapeContainsAnyTokenPoint(shape, token) {
    if (!shape) return false;
    return tokenVisibilityPoints(token).some((p) => pointInShape(shape, p.x, p.y));
  }

  function lightRadiusPixels(lightSource) {
    const data = lightSource?.data ?? lightSource ?? {};
    const doc = lightSource?.object?.document ?? lightSource?.document ?? {};
    const config = doc.config ?? data.config ?? {};
    const candidates = [
      data.radius,
      lightSource?.radius,
      data.dim,
      data.bright,
      config.dim,
      config.bright
    ].map(Number).filter((n) => Number.isFinite(n) && n > 0);

    if (!candidates.length) return 0;
    return Math.max(...candidates.map(maybeSceneDistanceToPixels));
  }

  function lightOrigin(lightSource) {
    const data = lightSource?.data ?? lightSource ?? {};
    const doc = lightSource?.object?.document ?? lightSource?.document ?? {};
    return lightSource?.origin ?? { x: data.x ?? lightSource?.x ?? doc.x, y: data.y ?? lightSource?.y ?? doc.y };
  }

  function hasWallBetweenPoints(a, b, type = "sight") {
    if (!Number.isFinite(a?.x) || !Number.isFinite(a?.y) || !Number.isFinite(b?.x) || !Number.isFinite(b?.y)) return false;

    const options = { type, mode: "any" };
    try {
      if (canvas.walls?.checkCollision) return Boolean(canvas.walls.checkCollision(a, b, options));
    } catch (_) {}

    try {
      const backend = CONFIG?.Canvas?.polygonBackends?.[type] ?? CONFIG?.Canvas?.polygonBackends?.sight;
      if (backend?.testCollision) return Boolean(backend.testCollision(a, b, options));
    } catch (_) {}

    try {
      const PolygonClass = foundry?.canvas?.geometry?.ClockwiseSweepPolygon ?? globalThis.ClockwiseSweepPolygon;
      if (PolygonClass?.testCollision) return Boolean(PolygonClass.testCollision(a, b, options));
    } catch (_) {}

    return false;
  }

  function isPointInLightSource(point, lightSource) {
    if (!lightSource) return false;
    if (lightSource.disabled || lightSource.active === false) return false;
    const data = lightSource.data ?? lightSource;
    if (data.disabled) return false;

    const origin = lightOrigin(lightSource);
    if (Number.isFinite(origin?.x) && Number.isFinite(origin?.y) && hasWallBetweenPoints(origin, point, "sight")) return false;

    const shape = lightSource.shape ?? lightSource.los ?? lightSource.fov;
    // If Foundry provides a light shape, treat it as authoritative. Falling back to
    // raw radius after a shape miss can falsely count targets outside the actual
    // rendered light area, especially for dim/attenuated or wall-clipped sources.
    if (shape) return pointInShape(shape, point.x, point.y);

    const radius = lightRadiusPixels(lightSource);
    if (!Number.isFinite(radius) || radius <= 0) return false;

    if (Number.isFinite(origin?.x) && Number.isFinite(origin?.y)) {
      return ((point.x - origin.x) ** 2 + (point.y - origin.y) ** 2) <= radius ** 2;
    }

    return false;
  }

  function isTokenIlluminated(targetToken) {
    // In globally illuminated scenes Foundry treats ordinary sight as lit enough.
    try {
      const darkness = Number(canvas.scene?.darkness ?? 0);
      const globalLight = Boolean(canvas.scene?.globalLight || canvas.scene?.globalIllumination || canvas.scene?.environment?.globalLight?.enabled);
      if (globalLight && darkness < 1) return true;
    } catch (_) {}

    const points = tokenIlluminationPoints(targetToken);
    const lightSources = [
      ...(canvas.effects?.lightSources?.values?.() ?? []),
      ...(canvas.effects?.illuminationSources?.values?.() ?? []),
      ...(canvas.lighting?.sources?.values?.() ?? [])
    ];

    for (const source of lightSources) {
      if (points.some((p) => isPointInLightSource(p, source))) return true;
    }

    return false;
  }

  function secondarySourceCanActuallySeeTarget(sourceToken, targetToken, context = {}) {
    const inRange = Boolean(context.inRange);
    const inLos = Boolean(context.inLos);
    if (!inLos) return false;

    const illuminated = isTokenIlluminated(targetToken);
    const specialVision = tokenHasSpecialDarknessVision(sourceToken, targetToken);

    // Strict intended rule for token-only enemy visibility:
    // secondary LOS AND (target is illuminated OR source has applicable special vision).
    if (illuminated) return true;
    if (inRange && specialVision) return true;

    return false;
  }

  function secondaryDecisionDetails(sourceToken, targetToken, context = {}) {
    const inRange = Boolean(context.inRange);
    const inLos = Boolean(context.inLos);
    const illuminated = isTokenIlluminated(targetToken);
    const special = specialVisionDetails(sourceToken, targetToken);
    const ownedAny = isOwnedByAnyPlayer(targetToken);
    const nonHostileOwned = isPlayerOwnedNonHostile(targetToken);
    const isSourceToken = Boolean(sourceToken && targetToken && sourceToken.id === targetToken.id);
    const allyBranch = Boolean((isSourceToken || nonHostileOwned) && inRange);
    const enemyBranch = Boolean(inLos && (illuminated || (inRange && (special.modeIsSpecial || special.inAnySenseRange))));
    return {
      inRange,
      inLos,
      illuminated,
      specialVision: special.modeIsSpecial || special.inAnySenseRange,
      special,
      targetOwnedByAnyPlayer: ownedAny,
      targetNonHostileOwned: nonHostileOwned,
      targetDisposition: tokenDisposition(targetToken),
      isSourceToken,
      allyBranch,
      enemyBranch,
      finalWouldShowByFormula: allyBranch || enemyBranch,
      reason: allyBranch ? "ally/source in secondary range"
        : enemyBranch ? (illuminated ? "secondary LOS + illuminated" : "secondary LOS + in-range special vision")
          : !inLos ? "blocked: no secondary LOS"
            : "blocked: no illumination and no applicable special vision"
    };
  }


  function isTokenOnlyInSecondaryVision(token, secondaryEntries, primaryShapes) {
    if (!token?.document || token.destroyed || token.document.hidden) return false;
    if (token.controlled) return false;

    const { x, y } = tokenCenter(token);
    const inPrimary = primaryShapes.some((shape) => pointInShape(shape, x, y));
    if (inPrimary) return false;

    const isSecondarySourceToken = secondaryEntries.some((entry) => entry?.token === token || entry?.token?.id === token.id);
    const isAllyLikeTarget = isSecondarySourceToken || isPlayerOwnedNonHostile(token);

    for (const entry of secondaryEntries) {
      const rangeShape = entry?.shape ?? entry;
      const losShape = entry?.losShape ?? rangeShape;

      // Enemy/hostile token detection must be conservative and match Foundry's
      // normal wall behavior: a token standing on or clipping a wall should not be
      // revealed from the far side just because one of its token-bound probes is
      // barely inside the secondary LOS polygon. Therefore enemies use center-only
      // range/LOS checks. Ally/source tokens keep the more permissive token-area
      // range check so party tokens themselves stay easy to discover.
      const inRangeCenter = pointInShape(rangeShape, x, y);
      const inLosCenter = pointInShape(losShape, x, y);
      const inRangeAny = shapeContainsAnyTokenPoint(rangeShape, token);
      const inLosAny = shapeContainsAnyTokenPoint(losShape, token);
      const inRange = isAllyLikeTarget ? (inRangeCenter || inRangeAny) : inRangeCenter;
      const inLos = isAllyLikeTarget ? (inRange || inLosCenter || inLosAny) : inLosCenter;
      if (!inLos) continue;

      if (isTokenOnlyMode() && entry?.token) {
        // Party/ally tokens are part of the shared information itself. Keep them
        // tied to normal secondary range so illuminated enemies outside range do
        // not accidentally make unrelated ally tokens appear through walls.
        if (isAllyLikeTarget && inRange) return true;

        // Non-player targets: visible in darkness only within range/special vision;
        // visible outside that range only if illuminated and in wall-bounded LOS.
        if (secondarySourceCanActuallySeeTarget(entry.token, token, { inRange, inLos })) return true;
        continue;
      }

      if (inRange) return true;
    }

    return false;
  }

  function drawTokenHatch(graphics, token) {
    // Token hatching is handled by Token#detectionFilter, matching GM Vision's visual style.
    // Keep this function as a no-op so the debug overlay can still report hatch targets.
  }
  function refreshSecondaryVision() {
    if (!canvas?.ready || game.user.isGM || isNoCanvas()) return;
    const hatch = ensureTokenHatch();
    if (!hatch) return;

    clearGraphics(hatch);
    secondaryDetectedTokenIds.clear();

    if (!isEnabledForThisClient()) return;
    if (!canvas.visibility?.tokenVision) return;

    const secondary = getSecondaryVisionEntries();
    const primaryShapes = getControlledVisionShapes();

    debug("refresh", {
      controlled: canvas.tokens.controlled.map((t) => t.name),
      secondary: secondary.map((e) => e.token.name),
      visionSources: Array.from(canvas.effects?.visionSources?.values?.() ?? []).map((s) => s.object?.name ?? s.token?.name ?? s.object?.id)
    });

    if (!secondary.length) return;
    const hatchTargets = (canvas.tokens?.placeables ?? [])
      .filter((token) => isTokenOnlyInSecondaryVision(token, secondary, primaryShapes));

    globalThis.PlayerVisionPlus = globalThis.PlayerVisionPlus ?? {};
    globalThis.PlayerVisionPlus.debugState = {
      controlled: canvas.tokens.controlled.map((t) => t.name),
      secondarySources: secondary.map((e) => ({
        name: e.token?.name,
        id: e.token?.id,
        radius: Math.round(sightRadiusPixels(e.token)),
        ownedByAnotherPlayer: isOwnedByAnotherPlayer(e.token),
        specialVision: tokenHasSpecialDarknessVision(e.token),
        hasShape: Boolean(e.shape),
        points: Array.isArray(e.shape?.points) ? e.shape.points.length : null
      })),
      hatchTargets: hatchTargets.map((t) => t.name),
      cachedIds: Array.from(secondaryDetectedTokenIds)
    };

    secondaryDetectedTokenIds.clear();
    for (const token of hatchTargets) secondaryDetectedTokenIds.add(token.id);

    for (const token of hatchTargets) drawTokenHatch(hatch, token);
    hatch.visible = false;

    // Re-evaluate token visibility so Foundry applies the same detection filter style used by GM Vision.
    canvas.tokens?.placeables?.forEach?.((token) => token.renderFlags?.set?.({ refreshVisibility: true }));

    debug("token hatch", { targets: hatchTargets.map((token) => token.name), visible: hatch.visible, style: "detectionFilter", cachedIds: Array.from(secondaryDetectedTokenIds) });
  }

  Hooks.once("init", () => {
    registerSettings();
    patchVisionSourceEligibility();
    patchTokenVisibilityFilter();
  });

  Hooks.once("setup", () => {
    if (isNoCanvas()) return;

    Hooks.on("drawCanvasInterface", () => {
      if (tokenHatch && !tokenHatch.destroyed) tokenHatch.destroy({ children: true });
      tokenHatch = null;
      ensureTokenHatch();
    });

    Hooks.on("sightRefresh", refreshSecondaryVision);
    Hooks.on("initializeVisionSources", () => window.setTimeout(scheduleSecondaryVisionRefresh, 0));
    Hooks.on("controlToken", refreshCanvasVision);
    Hooks.on("updateToken", refreshCanvasVision);
    Hooks.on("createToken", refreshCanvasVision);
    Hooks.on("deleteToken", refreshCanvasVision);

    // refreshToken fires while a token is being re-rendered or animated. This keeps
    // GM-Vision-style token-only visibility accurate for the whole movement path,
    // instead of only at the first or final grid position.
    Hooks.on("refreshToken", scheduleSecondaryVisionRefresh);

    Hooks.on("canvasReady", () => {
      tokenPositionCache.clear();
      refreshCanvasVision();
    });

    canvas.app?.ticker?.add?.(watchTokenMovementFrame);
  });

  // Small manual console helper while debugging in Foundry.
  window.PlayerVisionPlusDebug = function playerVisionPlusDebug() {
    const tokens = (canvas.tokens?.placeables ?? []).map((t) => ({
      name: t.name,
      id: t.id,
      controlled: t.controlled,
      hidden: t.document.hidden,
      hasSight: hasSight(t),
      isOwner: t.isOwner,
      actorOwnership: t.actor?.ownership,
      secondaryCandidate: isSecondaryTokenForCurrentView(t),
      ownedByAnotherPlayer: isOwnedByAnotherPlayer(t),
      hasVisionObject: Boolean(t.vision),
      inVisionSources: Boolean(canvas.effects?.visionSources?.get?.(t.sourceId) ?? canvas.effects?.visionSources?.get?.(t.id)),
      sightRange: t.document?.sight?.range,
      computedRadius: hasSight(t) ? Math.round(sightRadiusPixels(t)) : null,
      hasComputedShape: Boolean(getTokenVisionShape(t)),
      hasComputedSource: Boolean(getTokenVisionSource(t))
    }));
    const hatch = tokenHatch ?? canvas.interface?.children?.find?.(c => c.name === `${MODULE_ID}.tokenHatch`);
    const secondary = getSecondaryVisionEntries();
    const primaryShapes = getControlledVisionShapes();
    const hatchTargets = (canvas.tokens?.placeables ?? [])
      .filter((token) => isTokenOnlyInSecondaryVision(token, secondary, primaryShapes))
      .map((token) => token.name);
    console.table(tokens);
    console.log(`${MODULE_ID} token-only`, {
      foundryVersion: game.version,
      renderMode: renderMode(),
      hatch: {
        exists: Boolean(hatch),
        visible: hatch?.visible,
        parent: hatch?.parent?.name,
        childIndex: hatch?.parent?.children?.indexOf?.(hatch),
        bounds: hatch?.getLocalBounds?.(),
        targets: hatchTargets,
        cachedIds: Array.from(secondaryDetectedTokenIds),
        style: "GM Vision detectionFilter"
      }
    });
    return tokens;
  };

  window.PlayerVisionPlusTraceTarget = function playerVisionPlusTraceTarget(targetName = "The Enemy") {
    const target = (canvas.tokens?.placeables ?? []).find((t) => t.name === targetName)
      ?? (canvas.tokens?.placeables ?? []).find((t) => t.name?.toLowerCase?.().includes(String(targetName).toLowerCase()));
    if (!target) {
      console.warn(`${MODULE_ID} trace | target not found`, targetName);
      return null;
    }

    const secondary = getSecondaryVisionEntries();
    const primaryShapes = getControlledVisionShapes();
    const rows = secondary.map((entry) => {
      const center = tokenCenter(target);
      const inShapeCenter = pointInShape(entry.shape, center.x, center.y);
      const inShapeAny = shapeContainsAnyTokenPoint(entry.shape, target);
      const inLosCenter = pointInShape(entry.losShape ?? entry.shape, center.x, center.y);
      const inLosAny = shapeContainsAnyTokenPoint(entry.losShape ?? entry.shape, target);
      const isolatedFoundry = testVisibilityWithTemporarySource(entry.token, target);
      const isSecondarySourceToken = entry?.token === target || entry?.token?.id === target.id;
      const isAllyLikeTarget = isSecondarySourceToken || isPlayerOwnedNonHostile(target);
      const inRange = isAllyLikeTarget ? (inShapeCenter || inShapeAny) : inShapeCenter;
      const inLos = isAllyLikeTarget ? (inRange || inLosCenter || inLosAny) : inLosCenter;
      const details = secondaryDecisionDetails(entry.token, target, { inRange, inLos });
      return {
        source: entry.token?.name,
        sourceId: entry.token?.id,
        sourceOwnedByMe: isOwnedByCurrentUser(entry.token),
        sourceOwnedByAnotherPlayer: isOwnedByAnotherPlayer(entry.token),
        sourceSightRange: entry.token?.document?.sight?.range,
        sourceRadiusPx: Math.round(sightRadiusPixels(entry.token)),
        distance: details.special.distance,
        shapePoints: Array.isArray(entry.shape?.points) ? entry.shape.points.length : null,
        losShapePoints: Array.isArray(entry.losShape?.points) ? entry.losShape.points.length : null,
        inShapeCenter,
        inShapeAny,
        inLosCenter,
        inLosAny,
        inRange,
        inLos,
        illuminated: details.illuminated,
        specialVision: details.specialVision,
        activeSpecialRanges: details.special.activeRanges,
        targetDisposition: details.targetDisposition,
        targetOwnedByAnyPlayer: details.targetOwnedByAnyPlayer,
        targetNonHostileOwned: details.targetNonHostileOwned,
        allyBranch: details.allyBranch,
        enemyBranch: details.enemyBranch,
        reason: details.reason,
        litLosFallback: details.illuminated && inLos,
        isolatedFoundry,
        finalByFormula: details.finalWouldShowByFormula,
        finalWouldShow: isTokenOnlyInSecondaryVision(target, [entry], primaryShapes)
      };
    });
    console.table(rows);
    console.log(`${MODULE_ID} trace target`, {
      target: target.name,
      targetId: target.id,
      targetCenter: tokenCenter(target),
      targetVisible: target.visible,
      targetRenderable: target.renderable,
      targetDetectionFilter: Boolean(target.detectionFilter),
      inPrimary: primaryShapes.some((shape) => pointInShape(shape, tokenCenter(target).x, tokenCenter(target).y)),
      currentDebugState: globalThis.PlayerVisionPlus?.debugState
    });
    return rows;
  };


  window.PlayerVisionPlusTraceLights = function playerVisionPlusTraceLights(targetName = "The Enemy") {
    const target = (canvas.tokens?.placeables ?? []).find((t) => t.name === targetName)
      ?? (canvas.tokens?.placeables ?? []).find((t) => t.name?.toLowerCase?.().includes(String(targetName).toLowerCase()));
    if (!target) {
      console.warn(`${MODULE_ID} trace lights | target not found`, targetName);
      return null;
    }
    const points = tokenIlluminationPoints(target);
    const sources = [
      ...(canvas.effects?.lightSources?.values?.() ?? []),
      ...(canvas.effects?.illuminationSources?.values?.() ?? []),
      ...(canvas.lighting?.sources?.values?.() ?? [])
    ];
    const rows = sources.map((source, i) => {
      const data = source?.data ?? source ?? {};
      const doc = source?.object?.document ?? source?.document ?? {};
      const origin = lightOrigin(source);
      return {
        i,
        sourceId: source.sourceId ?? source.id ?? doc.id,
        active: source.active,
        disabled: source.disabled || data.disabled,
        objectName: source.object?.name ?? doc.name,
        x: origin?.x,
        y: origin?.y,
        radiusPx: Math.round(lightRadiusPixels(source)),
        hasShape: Boolean(source.shape),
        anyPointInShape: points.some((p) => pointInShape(source.shape ?? source.los ?? source.fov, p.x, p.y)),
        anyPointWallBlocked: points.some((p) => hasWallBetweenPoints(origin, p, "sight")),
        anyPointInSource: points.some((p) => isPointInLightSource(p, source))
      };
    });
    console.table(rows);
    console.log(`${MODULE_ID} trace lights`, { target: target.name, points, illuminated: isTokenIlluminated(target) });
    return rows;
  };

})();
