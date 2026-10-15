export const BACKGROUND = {
  enabled: true,
  terrain: true,
  video: 'assets/reference/background.mp4',
  poster: 'assets/reference/background-frame.png',
};

export function mountBackground({ reducedMotion }) {
  const root = document.querySelector('.bg');
  const video = root.querySelector('.bg-video');

  if (!BACKGROUND.enabled) {
    video.remove();
    return;
  }

  root.style.backgroundImage = `url("${encodeURI(BACKGROUND.poster)}")`;

  if (reducedMotion) {
    video.remove();
    return;
  }

  video.addEventListener('playing', () => video.classList.add('is-playing'), { once: true });
  video.src = encodeURI(BACKGROUND.video);
  video.play().catch(() => video.remove());
}

export function setBackgroundActive(active) {
  const video = document.querySelector('.bg-video');
  if (!video) return;
  if (active) video.play().catch(() => {});
  else video.pause();
}
