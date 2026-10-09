// The recorder page of an agent's browser recording (PLX-639), as T3 Code records: screencast
// frames drawn onto a canvas, which MediaRecorder records as WebM.
new Promise((resolve) => {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 800;
  document.body.append(canvas);
  const context = canvas.getContext("2d");
  const chunks = [];
  const recorder = new MediaRecorder(canvas.captureStream(30), {
    mimeType: "video/webm;codecs=vp8",
    videoBitsPerSecond: 1_500_000,
  });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  let latest = 0;
  let last;
  // The canvas only makes a video frame when it changes, so the last frame is drawn again
  // ten times a second, which keeps the video's clock running on a still page.
  const draw = () => {
    if (!last) return;
    const fit = Math.min(canvas.width / last.width, canvas.height / last.height);
    const [w, h] = [last.width * fit, last.height * fit];
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(last, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  };
  setInterval(draw, 100);
  window.__plxRecorder = {
    frame(base64) {
      const n = ++latest;
      const image = new Image();
      image.onload = () => {
        if (n !== latest) return;
        // Later frames fit inside the canvas, whose size a recording can't change.
        // The video starts with the first frame, at its size.
        if (recorder.state === "inactive") {
          canvas.width = image.width - (image.width % 2);
          canvas.height = image.height - (image.height % 2);
        }
        last = image;
        draw();
        if (recorder.state === "inactive") recorder.start(1000);
      };
      image.src = `data:image/jpeg;base64,${base64}`;
    },
    stop: () =>
      new Promise((done) => {
        if (recorder.state === "inactive") return done("");
        recorder.onstop = () => {
          const reader = new FileReader();
          reader.onload = () => done(String(reader.result).split(",")[1] ?? "");
          reader.readAsDataURL(new Blob(chunks, { type: "video/webm" }));
        };
        recorder.stop();
      }),
  };
  resolve(true);
});
