
Page({
  data: {
    news: null,
    loading: true,
    errorMessage: ''
  },

  onLoad(options) {
    if (!options.id) {
      this.setData({
        loading: false,
        errorMessage: '新闻编号缺失，无法打开新闻。'
      });
      return;
    }

    this.loadNews(options.id);
  },

  loadNews(id) {
    this.setData({
      loading: true,
      errorMessage: ''
    });

    wx.request({
      url: 'https://bball-api-pages.pages.dev/playerbuzz/public?id=' + encodeURIComponent(id),
      method: 'GET',

      success: (res) => {
        if (
          res.statusCode !== 200 ||
          !res.data ||
          res.data.success !== true ||
          !res.data.item
        ) {
          this.setData({
            errorMessage: '未找到这条新闻，请返回新闻列表。',
            loading: false
          });
          return;
        }

        const item = res.data.item;

        this.setData({
          news: {
            ...item,
            title: item.title || item.original_title || 'NBA News',
            content: item.content || item.original_content || '',
            displayTime: this.formatTime(item.published_at)
          },
          loading: false
        });
      },

      fail: () => {
        this.setData({
          loading: false,
          errorMessage: '网络连接失败，请稍后重试。'
        });
      }
    });
  },

  formatTime(value) {
    if (!value) {
      return '';
    }

    const date = new Date(value);

    if (isNaN(date.getTime())) {
      return value;
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  },

  goBack() {
    wx.navigateBack({
      delta: 1,
      fail: () => {
        wx.switchTab({
          url: '/pages/playerbuzz/playerbuzz'
        });
      }
    });
  }
});
