import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isMp4SupportedSync } from "../../core/canvasRecorder";
import { AppletHostAdapter } from "../../core/host";
import { AppletStage } from "../../ui/stage/AppletStage";
import { useCanvasBackingStore } from "../../ui/stage/hooks";
import {
  StageDivider,
  StageIconButton,
  StagePillButton,
  StagePills,
  StageReadout,
  StageSection,
  StageSegmented,
  StageSelect,
  StageSlider,
  StageToggle
} from "../../ui/stage/StageControls";
import { chapterIndexAt, CHAPTERS, clockAt, formatCosmicTime, STORY_DURATION } from "./clock";
import { exportFilm } from "./exportVideo";
import { renderScene, renderSpectrum, SceneOptions, SPECTRUM_H, SPECTRUM_W } from "./render";
import { createEarlyUniverseSim, SCENE_H, SCENE_W } from "./sim";
import type { Census, MatterExcess, SimSettings } from "./types";

type Props = {
  host?: AppletHostAdapter;
};

const TIP = {
  play: "Play or pause the film (Space).",
  prev: "Back to the start of this chapter, or the previous one (← or Page Up).",
  next: "Continue, or skip to the next chapter (→ or Page Down). Presentation clickers send these keys.",
  restart: "Back to the very beginning.",
  playback: "Playback speed. Only the pace on screen changes.",
  chapter: "Jump to a chapter.",
  story: "Scrub through the film. Jumps replay the simulation, so the picture is exactly what the film would show.",
  excess:
    "How many more particles than antiparticles there are, drawn hugely exaggerated so a few survivors are visible. Real ratio: about a billion and one to a billion.",
  newUniverse: "Different random positions and events; the physics and timeline stay the same.",
  captions: "Chapter titles and explanations, bottom left.",
  clock: "Cosmic time and temperature, top right.",
  legend: "Key to the particles currently on screen.",
  labels: "Short reaction labels next to some events, at most one every couple of seconds.",
  timeline: "Chapter timeline along the bottom edge.",
  spectrum: "Inset: photon energies against the energies needed to make pairs, split deuterium or ionise hydrogen.",
  pauseBetween: "Hold just before each chapter ends, so you can talk; → or Page Down continues.",
  cinematic:
    "Hide everything except time and temperature (C). Click the film to play or pause; the corner button or C brings the controls back.",
  cleanVideo: "Video with only time and temperature over the film, as in cinematic mode.",
  videoSpeed: "½× renders the film in slow motion: twice as long, every frame newly computed (no repeated frames).",
  resolution: "Video size. 1080p is best for a talk; 720p exports faster and works on more browsers.",
  fps: "Frames per second of the video.",
  exportBtn: "Render the whole film off-screen and download it. Uses the on-screen options above.",
  cancel: "Stop exporting; nothing is downloaded.",
  storyReadout: "Position in the film / its length.",
  photons: "Drawn photons are a sample: in reality there are about 1.6 billion per proton or neutron."
} as const;

const PLAYBACK_OPTIONS = [
  { value: 0.5, label: "½×" },
  { value: 1, label: "1×" },
  { value: 2, label: "2×" }
];

const EXCESS_OPTIONS: { value: MatterExcess; label: string; tip: string }[] = [
  { value: 2, label: "3 : 2", tip: "3 particles for every 2 antiparticles (few annihilations)." },
  { value: 4, label: "5 : 4", tip: "5 particles for every 4 antiparticles." },
  { value: 8, label: "9 : 8", tip: "9 particles for every 8 antiparticles (a big annihilation flash)." }
];

/** Pause this long before a chapter ends, while its caption is still fully visible. */
const HOLD_BEFORE_END = 0.55;
const DEFAULT_SEED = 42;

type ExportMessage = { short: string; detail: string };
type ExportState = { running: boolean; done: number; total: number; message: ExportMessage | null };

export function EarlyUniverseCanvas({ host }: Props): JSX.Element {
  const sceneRef = useRef<HTMLCanvasElement | null>(null);
  const spectrumRef = useRef<HTMLCanvasElement | null>(null);
  const reducedMotion = host?.readReducedMotion?.() ?? false;

  const [settings, setSettings] = useState<SimSettings>({ seed: DEFAULT_SEED, excess: 4 });
  const [playing, setPlaying] = useState(false);
  const [playback, setPlayback] = useState<number>(reducedMotion ? 0.5 : 1);
  const [pauseBetween, setPauseBetween] = useState(false);
  const [scene, setScene] = useState<SceneOptions>({
    captions: true,
    clock: true,
    legend: true,
    labels: true,
    timeline: false,
    gentle: reducedMotion,
    minimal: false
  });
  const [cinematic, setCinematic] = useState(false);
  const [cleanVideo, setCleanVideo] = useState(false);
  const [videoSpeed, setVideoSpeed] = useState<0.5 | 1>(1);
  const [showSpectrum, setShowSpectrum] = useState(true);
  const [story, setStory] = useState(0);
  const [counts, setCounts] = useState<Census | null>(null);
  const [resolution, setResolution] = useState<1080 | 720>(1080);
  const [fps, setFps] = useState<30 | 60>(30);
  const [exporting, setExporting] = useState<ExportState>({ running: false, done: 0, total: 0, message: null });
  const exportCancel = useRef(false);

  const sim = useMemo(() => createEarlyUniverseSim({ seed: DEFAULT_SEED, excess: 4 }), []);

  useCanvasBackingStore([spectrumRef]);

  // Refs let the animation loop and key handler read the latest values without restarting.
  const shownScene: SceneOptions = cinematic ? { ...scene, minimal: true } : scene;
  const live = useRef({ playing, playback, pauseBetween, scene: shownScene, showSpectrum, settings, exporting: false });
  live.current = { playing, playback, pauseBetween, scene: shownScene, showSpectrum, settings, exporting: exporting.running };

  const drawNow = useCallback(() => {
    const sctx = sceneRef.current?.getContext("2d");
    if (sctx && !live.current.exporting) {
      renderScene(sctx, { state: sim.state(), field: sim.field, settings: sim.settings }, live.current.scene);
    }
    const hctx = spectrumRef.current?.getContext("2d");
    if (hctx && live.current.showSpectrum && !live.current.scene.minimal) {
      renderSpectrum(hctx, sim.state());
    }
  }, [sim]);

  const syncReadouts = useCallback(() => {
    setStory(sim.state().story);
    setCounts(sim.census());
  }, [sim]);

  useEffect(() => {
    let last = performance.now();
    let lastReadout = -Infinity;
    let raf = 0;
    const tick = (time: number): void => {
      const dt = Math.min(0.1, (time - last) / 1000);
      last = time;
      const now = live.current;
      if (now.playing && !now.exporting) {
        const s = sim.state().story;
        let advance = dt * now.playback;
        let hold = false;
        if (now.pauseBetween) {
          const holdAt = CHAPTERS[chapterIndexAt(s)].end - HOLD_BEFORE_END;
          if (s < holdAt - 1e-6 && s + advance >= holdAt) {
            advance = holdAt - s;
            hold = true;
          }
        }
        sim.advance(advance);
        if (hold || sim.state().story >= STORY_DURATION) {
          setPlaying(false);
        }
      }
      drawNow();
      if (time - lastReadout > 200) {
        lastReadout = time;
        syncReadouts();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sim, drawNow, syncReadouts]);

  const seek = useCallback(
    (to: number) => {
      sim.seek(to);
      syncReadouts();
      drawNow();
    },
    [sim, syncReadouts, drawNow]
  );

  const togglePlay = useCallback(() => {
    if (live.current.exporting) {
      return;
    }
    if (!live.current.playing && sim.state().story >= STORY_DURATION - 1e-6) {
      seek(0);
    }
    setPlaying((p) => !p);
  }, [seek, sim]);

  const next = useCallback(() => {
    if (live.current.exporting) {
      return;
    }
    const s = sim.state().story;
    const index = chapterIndexAt(s);
    const holdAt = CHAPTERS[index].end - HOLD_BEFORE_END;
    // Held at the end of a chapter: just carry on into the next one.
    if (!live.current.playing && Math.abs(s - holdAt) < 0.05 && index < CHAPTERS.length - 1) {
      sim.advance(HOLD_BEFORE_END + 1e-3);
      setPlaying(true);
      return;
    }
    if (index < CHAPTERS.length - 1) {
      seek(CHAPTERS[index + 1].start);
      setPlaying(true);
    }
  }, [seek, sim]);

  const prev = useCallback(() => {
    if (live.current.exporting) {
      return;
    }
    const s = sim.state().story;
    const index = chapterIndexAt(s);
    const target = s - CHAPTERS[index].start > 1.5 || index === 0 ? CHAPTERS[index].start : CHAPTERS[index - 1].start;
    seek(target);
  }, [seek, sim]);

  const restart = useCallback(() => {
    setPlaying(false);
    seek(0);
    host?.onResult?.({ event: "restart" });
  }, [seek, host]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.altKey || e.ctrlKey || e.metaKey) {
        return;
      }
      if (e.key === " " && tag !== "BUTTON") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        prev();
      } else if (e.key === "Home") {
        e.preventDefault();
        restart();
      } else if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        setCinematic((on) => !on);
      } else if (e.key === "Escape" && !document.fullscreenElement) {
        setCinematic(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, next, prev, restart]);

  function changeSettings(patch: Partial<SimSettings>): void {
    const nextSettings = { ...settings, ...patch };
    const at = sim.state().story;
    setSettings(nextSettings);
    sim.reset(nextSettings);
    seek(at);
  }

  function setOption<K extends keyof SceneOptions>(key: K, value: SceneOptions[K]): void {
    const nextScene = { ...scene, [key]: value };
    live.current.scene = nextScene;
    setScene(nextScene);
    drawNow();
  }

  function setCinematicMode(on: boolean): void {
    live.current.scene = on ? { ...scene, minimal: true } : scene;
    setCinematic(on);
    drawNow();
  }

  async function startExport(): Promise<void> {
    setPlaying(false);
    exportCancel.current = false;
    const height = resolution;
    const width = Math.round((height * SCENE_W) / SCENE_H);
    setExporting({ running: true, done: 0, total: Math.round((STORY_DURATION * fps) / videoSpeed), message: null });
    live.current.exporting = true;
    const result = await exportFilm({
      settings,
      scene: cleanVideo ? { ...scene, minimal: true } : scene,
      width,
      height,
      fps,
      speed: videoSpeed,
      onProgress: (done, total, preview) => {
        setExporting({ running: true, done, total, message: null });
        const sctx = sceneRef.current?.getContext("2d");
        if (sctx && sceneRef.current) {
          sctx.setTransform(1, 0, 0, 1, 0, 0);
          sctx.drawImage(preview, 0, 0, sceneRef.current.width, sceneRef.current.height);
        }
      },
      isCancelled: () => exportCancel.current
    });
    live.current.exporting = false;
    const message: ExportMessage =
      result.status === "done"
        ? {
            short: result.format === "mp4" ? "saved MP4" : "saved zip",
            detail: `Saved as ${result.format === "mp4" ? "an MP4 video" : "a zip of frames"} in your downloads.`
          }
        : result.status === "cancelled"
          ? { short: "cancelled", detail: "Export cancelled; nothing was saved." }
          : { short: "failed", detail: `Export failed: ${result.message ?? "unknown error"}` };
    setExporting({ running: false, done: 0, total: 0, message });
    host?.onResult?.({ event: "export", status: result.status });
  }

  const clock = clockAt(story);
  const chapterIndex = clock.chapterIndex;
  const mp4 = useMemo(() => isMp4SupportedSync(), []);

  const toolbar = (
    <>
      <StagePillButton label="‹" tip={TIP.prev} disabled={exporting.running} onClick={prev} />
      <StageIconButton
        icon={playing ? "pause" : "play"}
        label={playing ? "Pause" : "Play"}
        tip={TIP.play}
        disabled={exporting.running}
        onClick={togglePlay}
      />
      <StagePillButton label="›" tip={TIP.next} disabled={exporting.running} onClick={next} />
      <StageIconButton icon="reset" label="Restart" tip={TIP.restart} disabled={exporting.running} onClick={restart} />
      <StageDivider />
      <StageSegmented ariaLabel="Playback speed" tip={TIP.playback} value={playback} options={PLAYBACK_OPTIONS} onChange={setPlayback} />
      <StageDivider />
      <StagePillButton label="Cinematic" tip={TIP.cinematic} disabled={exporting.running} onClick={() => setCinematicMode(true)} />
    </>
  );

  const exportProgress = exporting.total > 0 ? Math.round((100 * exporting.done) / exporting.total) : 0;

  const controls = (
    <>
      <StageSection title="Film">
        <StageSelect
          label="Chapter"
          tip={TIP.chapter}
          value={CHAPTERS[chapterIndex].id}
          options={CHAPTERS.map((c, i) => ({ value: c.id, label: `${i + 1}. ${c.title}` }))}
          disabled={exporting.running}
          onChange={(id) => seek(CHAPTERS.find((c) => c.id === id)?.start ?? 0)}
        />
        <StageSlider
          label="Position"
          display={`${story.toFixed(1)} / ${STORY_DURATION} s`}
          value={story}
          min={0}
          max={STORY_DURATION}
          step={0.1}
          tip={TIP.story}
          disabled={exporting.running}
          onChange={seek}
        />
        <StageSegmented
          ariaLabel="Matter to antimatter"
          label="Matter : antimatter (shown)"
          tip={TIP.excess}
          value={settings.excess}
          options={EXCESS_OPTIONS}
          disabled={exporting.running}
          onChange={(excess) => changeSettings({ excess })}
        />
        <StagePills>
          <StagePillButton
            label="New random universe"
            tip={TIP.newUniverse}
            disabled={exporting.running}
            onClick={() => changeSettings({ seed: settings.seed + 1 })}
          />
        </StagePills>
      </StageSection>
      <StageSection title="On screen">
        <StagePills>
          <StageToggle label="Captions" tip={TIP.captions} on={scene.captions} onChange={(on) => setOption("captions", on)} />
          <StageToggle label="Clock" tip={TIP.clock} on={scene.clock} onChange={(on) => setOption("clock", on)} />
          <StageToggle label="Legend" tip={TIP.legend} on={scene.legend} onChange={(on) => setOption("legend", on)} />
          <StageToggle label="Event labels" tip={TIP.labels} on={scene.labels} onChange={(on) => setOption("labels", on)} />
          <StageToggle label="Timeline" tip={TIP.timeline} on={scene.timeline} onChange={(on) => setOption("timeline", on)} />
          <StageToggle label="Energy inset" tip={TIP.spectrum} on={showSpectrum} onChange={setShowSpectrum} />
        </StagePills>
      </StageSection>
      <StageSection title="Presenting">
        <StagePills>
          <StageToggle label="Pause between chapters" tip={TIP.pauseBetween} on={pauseBetween} onChange={setPauseBetween} />
        </StagePills>
      </StageSection>
      <StageSection title="Export video" defaultOpen={false}>
        <StageSegmented
          ariaLabel="Resolution"
          label="Resolution"
          tip={TIP.resolution}
          value={resolution}
          options={[
            { value: 1080, label: "1080p" },
            { value: 720, label: "720p" }
          ]}
          disabled={exporting.running}
          onChange={setResolution}
        />
        <StageSegmented
          ariaLabel="Frame rate"
          label="Frame rate"
          tip={TIP.fps}
          value={fps}
          options={[
            { value: 30, label: "30 fps" },
            { value: 60, label: "60 fps" }
          ]}
          disabled={exporting.running}
          onChange={setFps}
        />
        <StageSegmented
          ariaLabel="Video speed"
          label="Video speed"
          tip={TIP.videoSpeed}
          value={videoSpeed}
          options={[
            { value: 0.5, label: "½×" },
            { value: 1, label: "1×" }
          ]}
          disabled={exporting.running}
          onChange={setVideoSpeed}
        />
        <StagePills>
          <StageToggle label="Clean video (time & temperature only)" tip={TIP.cleanVideo} on={cleanVideo} onChange={setCleanVideo} />
        </StagePills>
        <StagePills>
          {exporting.running ? (
            <StagePillButton label={`Cancel (${exportProgress}%)`} tip={TIP.cancel} onClick={() => (exportCancel.current = true)} />
          ) : (
            <StagePillButton
              label={mp4 ? "Export MP4" : "Export frames (zip)"}
              tip={mp4 ? TIP.exportBtn : `${TIP.exportBtn} This browser cannot encode MP4, so frames are saved as images in a zip.`}
              onClick={() => void startExport()}
            />
          )}
        </StagePills>
        {exporting.running ? (
          <StageReadout label="Rendering" value={`${exporting.done} / ${exporting.total} frames`} />
        ) : exporting.message ? (
          <StageReadout label="Export" value={exporting.message.short} tip={exporting.message.detail} />
        ) : null}
      </StageSection>
      <StageSection title="What is on screen" defaultOpen={false}>
        <StageReadout label="Position" tip={TIP.storyReadout} value={`${story.toFixed(1)} s`} />
        <StageReadout label="Cosmic time" value={`≈ ${formatCosmicTime(clock.tSec)}`} />
        {counts ? (
          <>
            <StageReadout label="Photons drawn" tip={TIP.photons} value={counts.photons} />
            {counts.quarks + counts.antiquarks > 0 ? (
              <StageReadout label="Quarks / antiquarks" value={`${counts.quarks} / ${counts.antiquarks}`} />
            ) : null}
            {counts.protons + counts.neutrons > 0 ? (
              <StageReadout label="Free p / n" value={`${counts.protons} / ${counts.neutrons}`} />
            ) : null}
            {counts.antiprotons + counts.antineutrons > 0 ? (
              <StageReadout label="Antiprotons / antineutrons" value={`${counts.antiprotons} / ${counts.antineutrons}`} />
            ) : null}
            <StageReadout label="Electrons / positrons" value={`${counts.electrons} / ${counts.positrons}`} />
            {counts.deuterons + counts.helium > 0 ? (
              <StageReadout label="Deuterium / helium-4" value={`${counts.deuterons} / ${counts.helium}`} />
            ) : null}
            {counts.helium > 0 ? (
              <StageReadout label="Helium share of mass" value={`${Math.round(counts.heliumMassFraction * 100)}%`} />
            ) : null}
            {counts.hydrogenAtoms + counts.heliumAtoms > 0 ? (
              <StageReadout label="Neutral H / He atoms" value={`${counts.hydrogenAtoms} / ${counts.heliumAtoms}`} />
            ) : null}
          </>
        ) : null}
      </StageSection>
    </>
  );

  const info = (
    <>
      <h4>What you are seeing</h4>
      <ul>
        <li>
          A cinematic sketch of the first 380,000 years. After inflation the clock follows the standard hot Big Bang:
          t ≈ 2.4 s / √g* × (kT / 1 MeV)⁻² until matter dominates.
        </li>
        <li>
          Events follow from the temperature: pairs appear only while photons carry more than 2mc², deuterium survives
          only once the rare very energetic photons can no longer split it, and atoms form when the Saha equation allows.
        </li>
        <li>
          Matter is drawn solid; antimatter is always hollow and magenta. Quark colours are the three colour charges
          (antiquarks carry anticolours, not drawn). Warm spheres are protons, cool spheres neutrons.
        </li>
        <li>
          Light is drawn as streaks coloured by energy: white above visible light, then visible colours, then ever
          dimmer red in the infrared.
        </li>
      </ul>
      <h4>Simplified on purpose</h4>
      <ul>
        <li>Nothing is to scale. Inflation is drawn as a 2⁸ zoom; the real growth is at least 10²⁶.</li>
        <li>Times before about 10⁻¹¹ s depend on the unknown details of inflation and reheating.</li>
        <li>
          Helium starts forming at kT ≈ 0.08 MeV (about 3–4 minutes), as in full reaction-network calculations; a pure
          Saha estimate, which ignores how fast deuterium is burned into helium, would put it a little later.
        </li>
        <li>
          Reheating is staged for clarity: the field first turns into light, then pairs condense out of the light.
          Really the field's decay products appear and mix all at once.
        </li>
        <li>
          The matter excess is enormously exaggerated (the slider). Really about one extra quark survived for every
          billion pairs, and why there is any excess at all is unknown.
        </li>
        <li>
          Particle numbers are symbolic: 32 nucleons survive, and the ~650 photons drawn are a sample (really ~1.6
          billion per nucleon). Gluons, neutrinos, muons and heavier quarks are not drawn.
        </li>
        <li>
          Pair creation is drawn as one photon splitting; really it takes two photons (or a nearby particle). Helium
          forms via helium-3 and tritium, not straight from two deuterons. Mesons stand in for pions.
        </li>
        <li>
          Event rates are tuned for screen time. Counts follow textbook formulas: n/p = e^(−Q/kT) until freeze-out at
          kT ≈ 0.8 MeV, then neutron decay (τ ≈ 879 s); Saha balance for deuterium and for electrons on H and He.
        </li>
        <li>
          Neutron decay stops once deuterium survives: from then on free neutrons are captured within seconds, long
          before they would decay.
        </li>
        <li>Space is a periodic comoving box: expansion shows only as cooling, with photons losing energy.</li>
        <li>
          The faint blotches in the glow are the stretched inflation ripples, which become the hot and cold spots of
          the CMB. They are drawn hugely exaggerated: really about 1 part in 100,000.
        </li>
        <li>The slow camera drift, bloom, vignette and grain are style only.</li>
        <li>
          From the end of annihilation the camera pulls back. The simulated box repeats (space is the same everywhere on
          large scales), so the wider view shows mirrored copies of it; rare atoms in those copies (deuterium, helium-3,
          lithium) appear far more often than they really do.
        </li>
      </ul>
      <h4>Presenting</h4>
      <ul>
        <li>Space play/pause · → or Page Down next · ← or Page Up back · Home restart.</li>
        <li>C toggles cinematic mode: only time and temperature on screen; click the film to play or pause.</li>
      </ul>
    </>
  );

  const inset = showSpectrum ? (
    <canvas
      ref={spectrumRef}
      style={{ width: SPECTRUM_W, height: SPECTRUM_H }}
      role="img"
      aria-label="Histogram of photon energies relative to kT, with reaction thresholds"
      title={TIP.spectrum}
    />
  ) : undefined;

  return (
    <AppletStage
      logicalWidth={SCENE_W}
      logicalHeight={SCENE_H}
      canvasRef={sceneRef}
      canvasLabel={`Early Universe, chapter ${chapterIndex + 1}: ${CHAPTERS[chapterIndex].title}`}
      onCanvasResize={drawNow}
      canvasProps={cinematic ? { onClick: togglePlay } : undefined}
      cinematic={cinematic ? { label: "Show controls (C)", onExit: () => setCinematicMode(false) } : undefined}
      toolbar={toolbar}
      controls={controls}
      controlsWidth={280}
      controlsDefaultOpen={false}
      inset={inset}
      info={info}
      play={{ visible: !playing && !exporting.running && story < 0.05, label: "Play the film", onClick: togglePlay }}
    />
  );
}
