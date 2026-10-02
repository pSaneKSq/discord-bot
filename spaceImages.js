// Модуль для управления космическими картинками
const SPACE_IMAGES = {
    // Главное меню
    main: 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=400&h=300&fit=crop',
    
    // Статистика сервера
    stats: 'https://images.unsplash.com/photo-1444703686981-a3abbc4d4fe3?w=400&h=300&fit=crop',
    
    // Активность пользователя
    activity: 'https://images.unsplash.com/photo-1465101162946-4377e57745c3?w=400&h=300&fit=crop',
    
    // Уровни и XP
    level: 'https://images.unsplash.com/photo-1419242902214-272b3f66ee7a?w=400&h=300&fit=crop',
    rank: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=400&h=300&fit=crop',
    
    // Тикеты
    ticket: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=400&h=300&fit=crop',
    ticket_close: 'https://images.unsplash.com/photo-1506318137071-a8bcbf6755dd?w=400&h=300&fit=crop',
    
    // Опросы
    poll: 'https://images.unsplash.com/photo-1534796636912-3b95b3ab5986?w=400&h=300&fit=crop',
    
    // Объявления
    announcement: 'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?w=400&h=300&fit=crop',
    
    // Предупреждения
    warning: 'https://images.unsplash.com/photo-1454789548728-9c52e403b6e2?w=400&h=300&fit=crop',
    
    // Модерация
    moderation: 'https://images.unsplash.com/photo-1464802686167-b939a6910659?w=400&h=300&fit=crop',
    
    // Приветствие
    welcome: 'https://images.unsplash.com/photo-1462332420958-a05d1e002413?w=400&h=300&fit=crop',
    
    // Автомодерация
    automod: 'https://images.unsplash.com/photo-1504384308090-c54be3852f33?w=400&h=300&fit=crop',
    
    // Реакционные роли
    reaction_roles: 'https://images.unsplash.com/photo-1532094349884-543bc11b234d?w=400&h=300&fit=crop',
    
    // Защита сервера
    security: 'https://images.unsplash.com/photo-1517976487492-5750f3195933?w=400&h=300&fit=crop',
    
    // Еженедельный отчёт
    weekly_report: 'https://images.unsplash.com/photo-1454789548728-9c52e403b6e2?w=400&h=300&fit=crop',
    
    // Профиль участника
    profile: 'https://images.unsplash.com/photo-1506318137071-a8bcbf6755dd?w=400&h=300&fit=crop',
    
    // Формы и заявки
    form: 'https://images.unsplash.com/photo-1507413245164-6160d8298b31?w=400&h=300&fit=crop',
    
    // Голосования
    vote: 'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=400&h=300&fit=crop',
    
    // Общие/дефолтные
    default: 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=400&h=300&fit=crop',
    success: 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=400&h=300&fit=crop',
    error: 'https://images.unsplash.com/photo-1504384308090-c54be3852f33?w=400&h=300&fit=crop'
};

// Получить картинку по типу команды
function getImage(type) {
    return SPACE_IMAGES[type] || SPACE_IMAGES.default;
}

// Получить случайную космическую картинку
function getRandomImage() {
    const images = Object.values(SPACE_IMAGES);
    return images[Math.floor(Math.random() * images.length)];
}

// Добавить картинку к embed
function addImageToEmbed(embed, type) {
    const imageUrl = getImage(type);
    embed.setImage(imageUrl);
    return embed;
}

module.exports = {
    getImage,
    getRandomImage,
    addImageToEmbed,
    SPACE_IMAGES
};
