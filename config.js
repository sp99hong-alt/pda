// PDA 앱 설정. 배포할 때 API_URL만 바꾸면 됩니다.
window.PDA_CONFIG = {
  // Apps Script 웹앱 주소 (배포 > 웹 앱 URL, .../exec 로 끝남)
  API_URL: 'https://script.google.com/macros/s/AKfycbwBaRucBEDVeOSFqc94e6bA61LQ381iZZDgDmN8f6uf-t6OEUMQoqEESJy0XmfQ1d6Q/exec',
  // 이 시간(분) 동안 조작이 없으면 자동 로그아웃 (공용 단말기)
  IDLE_LOGOUT_MIN: 120,
  // 업로드가 끝난 기록을 PDA에 남겨 두는 기간(일)
  KEEP_UPLOADED_DAYS: 7,
  // 한 번에 업로드하는 기록 수
  UPLOAD_BATCH: 200
};
