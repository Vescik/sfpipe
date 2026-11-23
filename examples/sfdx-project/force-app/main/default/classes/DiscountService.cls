public with sharing class DiscountService {
    public static Decimal apply(Decimal amount, Decimal percent) {
        return amount - (amount * percent / 100);
    }
}
