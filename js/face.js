/* ===================================================================
   face.js — автоматический поиск лица на фото и вырез головы (черепа).

   Как это работает:
     1. Пробуем MediaPipe Tasks Vision (BlazeFace short-range). Модель
        лежит в репозитории (assets/models), wasm-рантайм грузится с CDN.
        Детектор даёт рамку лица + 6 ключевых точек (глаза, нос, рот, уши).
     2. Если MediaPipe недоступен (нет сети/старый браузер) — пробуем
        нативный window.FaceDetector (есть в некоторых Chrome).
     3. Если и его нет — обрезаем по центру верхней трети кадра.

   Из точек глаз считаем:
       межзрачковое расстояние d  → размер черепа ≈ 3.0d
       угол наклона глаз          → выравниваем голову по горизонту
       центр головы               ≈ середина глаз + 0.32d вниз по оси лица
   Результат — квадратный кадр с головой, готовый для круглой маски.

   Всё выполняется в браузере, ни один байт фото никуда не отправляется.
   =================================================================== */

const Face = (() => {

  const MP_VERSION = '0.10.18';
  const MP_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
  const MP_WASM   = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
  const MODEL     = 'assets/models/blaze_face_short_range.tflite';

  const OUT_SIZE = 220;           // сторона итогового кадра головы, px
  const SKULL_K = 3.0;            // размер черепа в межзрачковых расстояниях
  const CENTER_K = 0.32;          // сдвиг от линии глаз вниз к центру головы
  const LOAD_TIMEOUT = 12000;

  let mpPromise = null;           // кэш инициализации MediaPipe
  let mpFailed = false;

  /* Промис с таймаутом — чтобы не висеть вечно на плохой сети. */
  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('таймаут ' + label)), ms)),
    ]);
  }

  /* Ленивая загрузка MediaPipe-детектора (один раз на страницу). */
  function getMediaPipe() {
    if (mpFailed) return Promise.resolve(null);
    if (mpPromise) return mpPromise;
    mpPromise = (async () => {
      const vision = await withTimeout(import(/* @vite-ignore */ MP_BUNDLE), LOAD_TIMEOUT, 'загрузки MediaPipe');
      const fileset = await withTimeout(vision.FilesetResolver.forVisionTasks(MP_WASM), LOAD_TIMEOUT, 'wasm');
      return await withTimeout(vision.FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: new URL(MODEL, location.href).href },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.35,
      }), LOAD_TIMEOUT, 'модели');
    })().catch((e) => {
      console.warn('[face] MediaPipe недоступен:', e.message);
      mpFailed = true;
      return null;
    });
    return mpPromise;
  }

  /* Прогреть детектор заранее (вызываем при входе в лобби). */
  function warmup() { getMediaPipe(); }

  /* --- детекция через MediaPipe --- */
  async function detectMediaPipe(img) {
    const det = await getMediaPipe();
    if (!det) return null;
    const res = det.detect(img);
    if (!res || !res.detections || !res.detections.length) return null;

    // берём самое крупное лицо
    const d = res.detections.reduce((a, b) =>
      (b.boundingBox.width * b.boundingBox.height > a.boundingBox.width * a.boundingBox.height) ? b : a);

    const bb = d.boundingBox;
    const box = { x: bb.originX, y: bb.originY, w: bb.width, h: bb.height };

    // keypoints нормированы 0..1; порядок BlazeFace: правый глаз, левый глаз, нос, рот, ухо, ухо
    let eyes = null;
    if (d.keypoints && d.keypoints.length >= 2) {
      eyes = [
        { x: d.keypoints[0].x * img.naturalWidth, y: d.keypoints[0].y * img.naturalHeight },
        { x: d.keypoints[1].x * img.naturalWidth, y: d.keypoints[1].y * img.naturalHeight },
      ];
    }
    return { box, eyes, method: 'mediapipe' };
  }

  /* --- детекция через нативный FaceDetector (если браузер умеет) --- */
  async function detectNative(img) {
    if (!('FaceDetector' in window)) return null;
    try {
      const fd = new window.FaceDetector({ fastMode: false, maxDetectedFaces: 5 });
      const faces = await fd.detect(img);
      if (!faces || !faces.length) return null;
      const f = faces.reduce((a, b) =>
        (b.boundingBox.width * b.boundingBox.height > a.boundingBox.width * a.boundingBox.height) ? b : a);
      const bb = f.boundingBox;
      const box = { x: bb.x, y: bb.y, w: bb.width, h: bb.height };

      let eyes = null;
      if (f.landmarks) {
        const pts = f.landmarks.filter(l => l.type === 'eye').map(l => l.locations[0]);
        if (pts.length >= 2) eyes = [pts[0], pts[1]];
      }
      return { box, eyes, method: 'native' };
    } catch (e) { return null; }
  }

  /* Геометрия выреза: центр, сторона квадрата и угол наклона. */
  function computeCrop(img, face) {
    const W = img.naturalWidth, H = img.naturalHeight;

    if (face && face.eyes) {
      const [e1, e2] = face.eyes;
      const d = Math.hypot(e2.x - e1.x, e2.y - e1.y) || (face.box.w * 0.4);
      const ang = Math.atan2(e2.y - e1.y, e2.x - e1.x);
      const mx = (e1.x + e2.x) / 2, my = (e1.y + e2.y) / 2;
      // ось лица = перпендикуляр к линии глаз, вниз
      const nx = Math.cos(ang + Math.PI / 2), ny = Math.sin(ang + Math.PI / 2);
      return {
        cx: mx + nx * d * CENTER_K,
        cy: my + ny * d * CENTER_K,
        side: Math.max(d * SKULL_K, face.box.w * 1.5),
        // угол наклона: приводим к горизонту (глаза могут идти «справа налево»)
        ang: Math.abs(ang) > Math.PI / 2 ? ang - Math.PI : ang,
        detected: true,
      };
    }
    if (face) {
      // рамка лица без точек: расширяем и поднимаем, чтобы влез лоб и макушка
      return {
        cx: face.box.x + face.box.w / 2,
        cy: face.box.y + face.box.h * 0.42,
        side: Math.max(face.box.w, face.box.h) * 1.65,
        ang: 0, detected: true,
      };
    }
    // ничего не нашли: голова обычно в верхней трети кадра
    const side = Math.min(W, H) * 0.82;
    return { cx: W / 2, cy: Math.min(H - side / 2, Math.max(side / 2, H * 0.38)), side, ang: 0, detected: false };
  }

  /* Отрисовать вырез в квадратный канвас нужного размера. */
  function renderCrop(img, crop, size) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const c = cv.getContext('2d');
    c.imageSmoothingQuality = 'high';

    // фон на случай, если вырез вылезает за края фото
    c.fillStyle = '#12121c';
    c.fillRect(0, 0, size, size);

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
    Главная функция: файл -> {dataURL, detected, method}.
    dataURL — квадрат OUT_SIZE x OUT_SIZE с головой по центру.
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

    let face = null;
    try { face = await detectMediaPipe(img); } catch (e) { console.warn('[face] mp:', e.message); }
    if (!face) { try { face = await detectNative(img); } catch (e) { } }

    const crop = computeCrop(img, face);
    const cv = renderCrop(img, crop, OUT_SIZE);

    return {
      dataURL: cv.toDataURL('image/jpeg', 0.85),
      detected: crop.detected,
      method: face ? face.method : 'center',
    };
  }

  return { cropHead, warmup };
})();
