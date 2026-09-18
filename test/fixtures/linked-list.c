struct node {
    int data;
    struct node* next;
};

int main() {
    struct node* head = malloc(sizeof(struct node));
    head->data = 7;
    head->next = NULL;
    return 0;
}
