/* ===================================================================
   face.js — поиск лица на фото и вырез головы ПО ФОРМЕ (с волосами),
   а не по кругу.

   Конвейер:
     1. FaceDetector (BlazeFace) находит лицо и 6 точек (глаза, нос, рот, уши).
        По межзрачковому расстоянию считаем размер черепа и наклон головы,
        вырезаем выровненный квадрат вокруг головы.
     2. ImageSegmenter (Selfie Segmenter) даёт маску «человек/фон» на этом
        квадрате — это и есть силуэт головы вместе с причёской.
     3. Маску умножаем на «окно головы» (овал с мягким низом), чтобы отсечь
        шею и плечи, слегка размываем край и кладём в альфа-канал.
     4. Результат — PNG с прозрачностью: в игре рисуется реальная форма головы.

   Модели (assets/models) и wasm-рантайм MediaPipe (js/vendor/mediapipe)
   лежат в репозитории — внешних запросов нет вообще. Никакого бэкенда:
   всё считается в браузере, фото никуда не уходит.

   Если что-то из этого недоступно — работает следующий уровень деградации,
   вплоть до простого овала по центру кадра. Игра не ломается никогда.
   =================================================================== */

const Face = (() => {

  // @mediapipe/tasks-vision 0.10.18, скопировано из npm-пакета как есть
  const MP_BUNDLE = new URL('js/vendor/mediapipe/vision_bundle.mjs', location.href).href;
  const MP_WASM   = new URL('js/vendor/mediapipe/wasm', location.href).href;
  const MODEL_FACE = 'assets/models/blaze_face_short_range.tflite';
  const MODEL_SEG  = 'assets/models/selfie_segmenter.tflite';

  const OUT_SIZE = 224;           // сторона итогового кадра головы, px
  const SKULL_K = 3.15;           // размер черепа в межзрачковых расстояниях
  const CENTER_K = 0.30;          // сдвиг от линии глаз вниз к центру головы
  const LOAD_TIMEOUT = 15000;

  let visionPromise = null;       // общий ESM-модуль MediaPipe
  let facePromise = null, segPromise = null;
  let visionFailed = false;

  function withTimeout(p, ms, label) {
    return Promise.race([p, new Promise((_, rej) =>
      setTimeout(() => rej(new Error('таймаут ' + label)), ms))]);
  }

  /* ---------- ленивая загрузка MediaPipe ---------- */
  function getVision() {
    if (visionFailed) return Promise.resolve(null);
    if (!visionPromise) {
      visionPromise = (async () => {
        const vision = await withTimeout(import(/* @vite-ignore */ MP_BUNDLE), LOAD_TIMEOUT, 'загрузки MediaPipe');
        const fileset = await withTimeout(vision.FilesetResolver.forVisionTasks(MP_WASM), LOAD_TIMEOUT, 'wasm');
        return { vision, fileset };
      })().catch(e => { console.warn('[face] MediaPipe недоступен:', e.message); visionFailed = true; return null; });
    }
    return visionPromise;
  }

  function getFaceDetector() {
    if (!facePromise) {
      facePromise = (async () => {
        const v = await getVision(); if (!v) return null;
        return await withTimeout(v.vision.FaceDetector.createFromOptions(v.fileset, {
          baseOptions: { modelAssetPath: new URL(MODEL_FACE, location.href).href },
          runningMode: 'IMAGE', minDetectionConfidence: 0.35,
        }), LOAD_TIMEOUT, 'модели лица');
      })().catch(e => { console.warn('[face] детектор лиц:', e.message); return null; });
    }
    return facePromise;
  }

  function getSegmenter() {
    if (!segPromise) {
      segPromise = (async () => {
        const v = await getVision(); if (!v) return null;
        return await withTimeout(v.vision.ImageSegmenter.createFromOptions(v.fileset, {
          baseOptions: { modelAssetPath: new URL(MODEL_SEG, location.href).href },
          runningMode: 'IMAGE', outputCategoryMask: false, outputConfidenceMasks: true,
        }), LOAD_TIMEOUT, 'модели сегментации');
      })().catch(e => { console.warn('[face] сегментация:', e.message); return null; });
    }
    return segPromise;
  }

  /* Прогреть всё заранее (вызываем при входе в лобби). */
  function warmup() { getFaceDetector(); getSegmenter(); }

  /* ---------- ДЕТЕКЦИЯ ЛИЦА ---------- */
  async function detectFace(img) {
    // 1) MediaPipe
    try {
      const det = await getFaceDetector();
      if (det) {
        const res = det.detect(img);
        if (res && res.detections && res.detections.length) {
          const d = res.detections.reduce((a, b) =>
            b.boundingBox.width * b.boundingBox.height > a.boundingBox.width * a.boundingBox.height ? b : a);
          const bb = d.boundingBox;
          let eyes = null;
          if (d.keypoints && d.keypoints.length >= 2) {
            eyes = [
              { x: d.keypoints[0].x * img.naturalWidth, y: d.keypoints[0].y * img.naturalHeight },
              { x: d.keypoints[1].x * img.naturalWidth, y: d.keypoints[1].y * img.naturalHeight },
            ];
          }
          return { box: { x: bb.originX, y: bb.originY, w: bb.width, h: bb.height }, eyes, method: 'mediapipe' };
        }
      }
    } catch (e) { console.warn('[face] detect:', e.message); }

    // 2) нативный FaceDetector (часть сборок Chrome)
    if ('FaceDetector' in window) {
      try {
        const fd = new window.FaceDetector({ fastMode: false, maxDetectedFaces: 5 });
        const faces = await fd.detect(img);
        if (faces && faces.length) {
          const f = faces.reduce((a, b) =>
            b.boundingBox.width * b.boundingBox.height > a.boundingBox.width * a.boundingBox.height ? b : a);
          const bb = f.boundingBox;
          let eyes = null;
          if (f.landmarks) {
            const pts = f.landmarks.filter(l => l.type === 'eye').map(l => l.locations[0]);
            if (pts.length >= 2) eyes = [pts[0], pts[1]];
          }
          return { box: { x: bb.x, y: bb.y, w: bb.width, h: bb.height }, eyes, method: 'native' };
        }
      } catch (e) { }
    }
    return null;
  }

  /* Геометрия выреза: центр, сторона квадрата и угол наклона головы. */
  function computeCrop(img, face) {
    const W = img.naturalWidth, H = img.naturalHeight;

    if (face && face.eyes) {
      const [e1, e2] = face.eyes;
      const d = Math.hypot(e2.x - e1.x, e2.y - e1.y) || face.box.w * 0.4;
      let ang = Math.atan2(e2.y - e1.y, e2.x - e1.x);
      if (Math.abs(ang) > Math.PI / 2) ang -= Math.sign(ang) * Math.PI;   // глаза могут идти справа налево
      const mx = (e1.x + e2.x) / 2, my = (e1.y + e2.y) / 2;
      const nx = Math.cos(ang + Math.PI / 2), ny = Math.sin(ang + Math.PI / 2);
      return {
        cx: mx + nx * d * CENTER_K,
        cy: my + ny * d * CENTER_K,
        side: Math.max(d * SKULL_K, face.box.w * 1.6),
        ang, detected: true,
      };
    }
    if (face) {
      return {
        cx: face.box.x + face.box.w / 2,
        cy: face.box.y + face.box.h * 0.40,
        side: Math.max(face.box.w, face.box.h) * 1.7,
        ang: 0, detected: true,
      };
    }
    const side = Math.min(W, H) * 0.80;
    return { cx: W / 2, cy: U.clamp(H * 0.38, side / 2, H - side / 2), side, ang: 0, detected: false };
  }

  /* Вырезать выровненный квадрат вокруг головы. */
  function renderCrop(img, crop, size) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const c = cv.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.save();
    c.translate(size / 2, size / 2);
    c.rotate(-crop.ang);
    const k = size / crop.side;
    c.scale(k, k);
    c.translate(-crop.cx, -crop.cy);
    c.drawImage(img, 0, 0);
    c.restore();
    return cv;
  }

  /*
    «Окно головы»: суперэллипс, чуть вытянутый по вертикали, с мягким
    затуханием внизу — чтобы шея и плечи не попали в вырез.
    Возвращает канвас-маску (белое = видно).
  */
  function headWindow(size) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const c = cv.getContext('2d');
    const id = c.createImageData(size, size);
    const a = 0.50, b = 0.56, n = 2.7;          // полуоси в долях стороны и степень
    for (let y = 0; y < size; y++) {
      const dy = (y / size - 0.50) / b;
      for (let x = 0; x < size; x++) {
        const dx = (x / size - 0.50) / a;
        const r = Math.pow(Math.abs(dx), n) + Math.pow(Math.abs(dy), n);
        let v = U.clamp(1 - (r - 0.86) / 0.30, 0, 1);        // мягкий край
        const bottom = y / size;
        if (bottom > 0.80) v *= U.clamp(1 - (bottom - 0.80) / 0.18, 0, 1);   // срез шеи
        const p = (y * size + x) * 4;
        id.data[p] = id.data[p + 1] = id.data[p + 2] = 255;
        id.data[p + 3] = Math.round(v * 255);
      }
    }
    c.putImageData(id, 0, 0);
    return cv;
  }

  /*
    Маска человека на вырезе через ImageSegmenter.
    Возвращает канвас (альфа = вероятность «это человек») или null.
  */
  async function personMask(cropCanvas, size) {
    const seg = await getSegmenter();
    if (!seg) return null;
    let res = null;
    try {
      res = seg.segment(cropCanvas);
      const masks = res.confidenceMasks;
      if (!masks || !masks.length) return null;
      // у selfie-сегментера две категории: фон и человек
      const m = masks.length > 1 ? masks[1] : masks[0];
      const data = m.getAsFloat32Array();
      const mw = m.width, mh = m.height;

      // средняя вероятность в центре — там гарантированно голова.
      // если там «фон», значит каналы перепутаны — инвертируем.
      let sum = 0, n = 0;
      for (let y = (mh * 0.35) | 0; y < mh * 0.65; y++)
        for (let x = (mw * 0.35) | 0; x < mw * 0.65; x++) { sum += data[y * mw + x]; n++; }
      const invert = (sum / Math.max(1, n)) < 0.5;

      const mc = document.createElement('canvas');
      mc.width = mw; mc.height = mh;
      const mctx = mc.getContext('2d');
      const id = mctx.createImageData(mw, mh);
      for (let i = 0; i < data.length; i++) {
        let v = data[i];
        if (invert) v = 1 - v;
        v = U.clamp((v - 0.35) / 0.30, 0, 1);        // подтягиваем контраст маски
        const p = i * 4;
        id.data[p] = id.data[p + 1] = id.data[p + 2] = 255;
        id.data[p + 3] = Math.round(v * 255);
      }
      mctx.putImageData(id, 0, 0);

      // растягиваем до размера выреза с лёгким размытием края
      const out = document.createElement('canvas');
      out.width = out.height = size;
      const octx = out.getContext('2d');
      octx.imageSmoothingQuality = 'high';
      try { octx.filter = 'blur(1.5px)'; } catch (e) { }
      octx.drawImage(mc, 0, 0, size, size);
      return out;
    } catch (e) {
      console.warn('[face] segment:', e.message);
      return null;
    } finally {
      if (res && res.close) { try { res.close(); } catch (e) { } }
    }
  }

  /*
    Главная функция: файл -> {dataURL(PNG с прозрачностью), detected, cutout, method}.
  */
  async function cropHead(file) {
    if (!file || !file.type.startsWith('image/')) throw new Error('не картинка');

    const raw = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
    const img = await U.loadImage(raw);

    const face = await detectFace(img);
    const crop = computeCrop(img, face);
    const cv = renderCrop(img, crop, OUT_SIZE);

    // альфа = маска человека (если есть) * окно головы
    const win = headWindow(OUT_SIZE);
    const person = await personMask(cv, OUT_SIZE);

    const alpha = document.createElement('canvas');
    alpha.width = alpha.height = OUT_SIZE;
    const ac = alpha.getContext('2d');
    ac.drawImage(win, 0, 0);
    if (person) {
      ac.globalCompositeOperation = 'destination-in';   // пересечение масок
      ac.drawImage(person, 0, 0);
      ac.globalCompositeOperation = 'source-over';
    }

    const cctx = cv.getContext('2d');
    cctx.globalCompositeOperation = 'destination-in';
    cctx.drawImage(alpha, 0, 0);
    cctx.globalCompositeOperation = 'source-over';

    return {
      dataURL: cv.toDataURL('image/png'),
      detected: crop.detected,
      cutout: !!person,
      method: face ? face.method : 'center',
    };
  }

  return { cropHead, warmup };
})();
