/**
 * `docker compose` pointed at the file mvpfy generated: beside the code for a
 * managed clone, inside `.mvpfy/` for a linked folder (whose root it must not
 * litter), with the project directory kept at the repo root either way.
 */
export function composeBase(linked: boolean): string {
  return linked
    ? 'docker compose -f .mvpfy/docker-compose.mvpfy.yml --project-directory .'
    : 'docker compose -f docker-compose.mvpfy.yml';
}
