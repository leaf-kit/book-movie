/* TMDb(The Movie Database) API 키.
 *
 * https://www.themoviedb.org 에 무료로 가입하면 설정 > API 메뉴에서
 * "API Key (v3 auth)" 를 받을 수 있다. 그 값을 아래에 넣는다.
 *
 * 이 저장소는 정적 페이지라 빌드 단계가 없다. 그래서 이 키는 결국
 * 브라우저로 그대로 전달되고, 깃허브에 커밋하면 공개된다. TMDb의 v3 키는
 * 원래 이런 클라이언트 쪽 사용을 전제로 설계된 키라 문제는 없지만,
 * 이 키로 걸리는 호출량은 이 계정 몫이라는 점은 알아 둔다. */
window.TMDB_API_KEY = '';
